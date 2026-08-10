import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const TEN_MINUTES_SECONDS = 10 * 60;
const PENDING_DECISION = "pending";

export type CreationGuardDecision =
  | "automatic"
  | "approval-request"
  | { readonly type: "denied"; readonly reason: "one_creation_per_turn" };

export interface CreationGuardContext {
  readonly callId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CreationGuard {
  reserve(context: CreationGuardContext): Promise<CreationGuardDecision>;
}

export interface CreationGuardStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: { ex: number; nx?: boolean }): Promise<unknown>;
}

interface SlidingWindowLimiter {
  limit(identifier: string): Promise<unknown>;
}

export interface UpstashCreationGuardOptions {
  readonly limiter?: SlidingWindowLimiter;
  readonly onDiagnostic?: (outcome: "automatic" | "limit" | "unavailable" | "second-creation") => void;
  readonly store?: CreationGuardStore;
  readonly token?: string;
  readonly url?: string;
}

function decisionKey(callId: string) {
  return `bud:creation-guard:decision:${callId}`;
}

function turnKey(sessionId: string, turnId: string) {
  return `bud:creation-guard:turn:${sessionId}:${turnId}`;
}

function parseDecision(value: unknown): CreationGuardDecision | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === "automatic" || parsed === "approval-request") return parsed;
    if (typeof parsed === "object" && parsed !== null &&
      (parsed as { type?: unknown }).type === "denied" &&
      (parsed as { reason?: unknown }).reason === "one_creation_per_turn") {
      return { type: "denied", reason: "one_creation_per_turn" };
    }
  } catch { /* malformed durable state is safely treated as unavailable */ }
  return undefined;
}

function isStoredValue(value: unknown): value is string {
  return typeof value === "string";
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isSuccessfulLimit(value: unknown): value is { success: boolean; reason?: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { success?: unknown }).success === "boolean";
}

export function createFakeCreationGuard(decisions: readonly CreationGuardDecision[] = []): CreationGuard & {
  readonly requests: CreationGuardContext[];
} {
  const requests: CreationGuardContext[] = [];
  let nextDecision = 0;
  return {
    requests,
    async reserve(context) {
      requests.push(context);
      return decisions[nextDecision++] ?? "automatic";
    },
  };
}

export function createApprovalFallbackCreationGuard(): CreationGuard {
  return { async reserve() { return "approval-request"; } };
}

export function createUpstashCreationGuard(options: UpstashCreationGuardOptions): CreationGuard {
  if (!options.store && (!options.url || !options.token)) return createApprovalFallbackCreationGuard();

  const store = options.store ?? new Redis({ url: options.url!, token: options.token! });
  const limiter = options.limiter ?? new Ratelimit({
    redis: store as Redis,
    limiter: Ratelimit.slidingWindow(10, "10 m"),
    prefix: "bud:creation-guard:attempt",
  });
  const inFlight = new Map<string, Promise<CreationGuardDecision>>();

  async function persist(callId: string, decision: CreationGuardDecision) {
    await store.set(decisionKey(callId), JSON.stringify(decision), { ex: TEN_MINUTES_SECONDS });
    return decision;
  }

  async function awaitDecision(callId: string) {
    while (true) {
      const stored = await store.get(decisionKey(callId));
      const decision = parseDecision(stored);
      if (decision) return decision;
      if (stored !== PENDING_DECISION) return undefined;
      await pause(25);
    }
  }

  async function reserve(context: CreationGuardContext): Promise<CreationGuardDecision> {
    try {
      const stored = await store.get(decisionKey(context.callId));
      const existing = parseDecision(stored);
      if (existing) return existing;

      if (isStoredValue(stored) && stored !== PENDING_DECISION) {
        options.onDiagnostic?.("unavailable");
        return "approval-request";
      }

      const claimedCall = stored === PENDING_DECISION ? null : await store.set(
        decisionKey(context.callId), PENDING_DECISION, { ex: TEN_MINUTES_SECONDS, nx: true },
      );
      if (!claimedCall) {
        return (await awaitDecision(context.callId)) ?? reserve(context);
      }

      const reservedTurn = await store.set(turnKey(context.sessionId, context.turnId), context.callId, {
        ex: TEN_MINUTES_SECONDS, nx: true,
      });
      if (!reservedTurn) {
        options.onDiagnostic?.("second-creation");
        return persist(context.callId, { type: "denied", reason: "one_creation_per_turn" });
      }

      const limit = await limiter.limit(context.ownerId);
      if (!isSuccessfulLimit(limit) || limit.reason === "timeout") {
        options.onDiagnostic?.("unavailable");
        return persist(context.callId, "approval-request");
      }
      if (!limit.success) {
        options.onDiagnostic?.("limit");
        return persist(context.callId, "approval-request");
      }
      options.onDiagnostic?.("automatic");
      return persist(context.callId, "automatic");
    } catch {
      options.onDiagnostic?.("unavailable");
      return "approval-request";
    }
  }

  return {
    reserve(context) {
      const running = inFlight.get(context.callId);
      if (running) return running;
      const result = reserve(context).finally(() => inFlight.delete(context.callId));
      inFlight.set(context.callId, result);
      return result;
    },
  };
}
