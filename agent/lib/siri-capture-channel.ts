import { Redis } from "@upstash/redis";
import { defineChannel, POST, type Session } from "eve/channels";
import type { TelegramChannel } from "eve/channels/telegram";

import type { BudConfig } from "./config.js";

const APPLICATION_DEADLINE_MS = 10_000;
const INVOCATION_TTL_SECONDS = 10 * 60;
const LONG_RESPONSE_HANDOFF = "Bud has a longer response in Telegram.";
const PENDING_INVOCATION = "pending";

type SiriResult = { readonly speech: string; readonly status: "completed" | "pending" };

export interface SiriInvocationStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: { ex: number; nx?: boolean }): Promise<unknown>;
}

export interface SiriCaptureDependencies {
  readonly deadlineMilliseconds?: number;
  readonly invocationStore?: SiriInvocationStore;
}

function invocationKey(requestId: string) {
  return `bud:siri:invocation:${requestId}`;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseResult(value: unknown): SiriResult | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as { speech?: unknown; status?: unknown };
    if ((parsed.status === "completed" || parsed.status === "pending") &&
      typeof parsed.speech === "string") {
      return { speech: parsed.speech, status: parsed.status };
    }
  } catch { /* An unrecognised durable value is not a reusable response. */ }
  return undefined;
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function configuredStore(config: BudConfig): SiriInvocationStore | undefined {
  if (!config.upstashRedis) return undefined;
  const redis = new Redis({ token: config.upstashRedis.token, url: config.upstashRedis.url });
  return {
    get(key) { return redis.get(key); },
    set(key, value, options) {
      return options.nx
        ? redis.set(key, value, { ex: options.ex, nx: true })
        : redis.set(key, value, { ex: options.ex });
    },
  };
}

function pendingResult(): SiriResult {
  return { status: "pending", speech: "Bud is continuing in Telegram." };
}

function speak(text: string): SiriResult {
  return text.length <= 800
    ? { status: "completed", speech: text }
    : { status: "pending", speech: LONG_RESPONSE_HANDOFF };
}

function eventMessage(event: unknown): string | undefined {
  const value = event as { data?: { finishReason?: unknown; message?: unknown }; type?: unknown };
  return value.type === "message.completed" && value.data?.finishReason !== "tool-calls" &&
    typeof value.data?.message === "string"
    ? value.data.message
    : undefined;
}

function eventFailure(event: unknown): string | undefined {
  const value = event as { data?: { message?: unknown }; type?: unknown };
  return (value.type === "turn.failed" || value.type === "session.failed") &&
    typeof value.data?.message === "string"
    ? `Bud couldn't complete that: ${value.data.message}`
    : undefined;
}

function isBoundary(event: unknown) {
  const type = (event as { type?: unknown }).type;
  return type === "input.requested" || type === "session.waiting" || type === "session.completed" ||
    type === "turn.completed" || type === "turn.failed" || type === "session.failed";
}

async function observeTurn(session: Session, deadlineMilliseconds: number): Promise<SiriResult> {
  const reader = (await session.getEventStream()).getReader();
  let latestMessage: string | undefined;
  let releaseAfterRead = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMilliseconds); });
  try {
    while (true) {
      const read = reader.read();
      const next = await Promise.race([read, deadline]);
      if (next === "timeout") {
        // The stream reader is only an observer. Keep the in-flight read alive
        // until it settles, then release its lock; never cancel Eve's turn.
        releaseAfterRead = true;
        void read.catch(() => undefined).finally(() => reader.releaseLock());
        return pendingResult();
      }
      if (next.done) return latestMessage ? speak(latestMessage) : pendingResult();
      const failure = eventFailure(next.value);
      if (failure) return speak(failure);
      latestMessage = eventMessage(next.value) ?? latestMessage;
      if (isBoundary(next.value)) return latestMessage ? speak(latestMessage) : pendingResult();
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (!releaseAfterRead) reader.releaseLock();
  }
}

async function awaitInvocation(store: SiriInvocationStore, key: string): Promise<SiriResult | undefined> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await store.get(key);
    const result = parseResult(value);
    if (result) return result;
    if (value !== PENDING_INVOCATION) return undefined;
    await pause(25);
  }
  return undefined;
}

export function createSiriCaptureChannel(
  config: BudConfig,
  telegram: TelegramChannel,
  dependencies: SiriCaptureDependencies = {},
) {
  const store = dependencies.invocationStore ?? configuredStore(config);
  const deadlineMilliseconds = dependencies.deadlineMilliseconds ?? APPLICATION_DEADLINE_MS;
  return defineChannel({
    state: {},
    routes: [
      POST("/eve/v1/siri", async (request, { receive }) => {
        if (!config.siriCaptureToken) {
          return Response.json({ error: "capture_not_configured" }, { status: 503 });
        }
        if (!store) {
          return Response.json({ error: "capture_not_configured" }, { status: 503 });
        }
        if (request.headers.get("authorization") !== `Bearer ${config.siriCaptureToken}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => undefined) as
          | { message?: unknown; requestId?: unknown }
          | undefined;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return Response.json({ error: "invalid_message" }, { status: 400 });
        if (message.length > 2_000) return Response.json({ error: "message_too_long" }, { status: 413 });
        if (!isRequestId(body?.requestId)) return Response.json({ error: "invalid_request_id" }, { status: 400 });

        const key = invocationKey(body.requestId);
        const existing = parseResult(await store.get(key));
        if (existing) return Response.json(existing, { status: existing.status === "completed" ? 200 : 202 });
        const claimed = await store.set(key, PENDING_INVOCATION, { ex: INVOCATION_TTL_SECONDS, nx: true });
        if (!claimed) {
          const result = await awaitInvocation(store, key);
          return Response.json(result ?? pendingResult(), { status: result?.status === "completed" ? 200 : 202 });
        }

        try {
          const session = await receive(telegram, {
            auth: {
              attributes: { capture_source: "siri-shortcut", chat_id: config.ownerId,
                chat_type: "private", user_id: config.ownerId },
              authenticator: "siri-shortcut", issuer: "bud", principalId: `telegram:${config.ownerId}`,
              principalType: "user",
            },
            message,
            target: { chatId: config.ownerId, initialMessage: `🎙 You via Siri: ${message}` },
          });
          const result = await observeTurn(session, deadlineMilliseconds);
          await store.set(key, JSON.stringify(result), { ex: INVOCATION_TTL_SECONDS });
          return Response.json(result, { status: result.status === "completed" ? 200 : 202 });
        } catch {
          const result = { status: "completed", speech: "Bud couldn't complete that. Please check Telegram." } as const;
          await store.set(key, JSON.stringify(result), { ex: INVOCATION_TTL_SECONDS });
          return Response.json(result, { status: 200 });
        }
      }),
    ],
  });
}
