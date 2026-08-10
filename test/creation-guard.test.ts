import { expect, it } from "vitest";

import {
  createApprovalFallbackCreationGuard,
  createFakeCreationGuard,
  createUpstashCreationGuard,
  type CreationGuard,
  type CreationGuardContext,
} from "../agent/lib/creation-guard.js";

class FakeStore {
  private readonly values = new Map<string, { expiresAt: number; value: string }>();
  readonly writes: Array<{ key: string; options: { ex: number; nx?: boolean } }> = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string) {
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: string, options: { ex: number; nx?: boolean }) {
    this.writes.push({ key, options });
    if (options.nx && await this.get(key) !== null) return null;
    this.values.set(key, { expiresAt: this.now() + options.ex * 1_000, value });
    return "OK";
  }
  seed(key: string, value: string) {
    this.values.set(key, { expiresAt: Number.POSITIVE_INFINITY, value });
  }
}

const request: CreationGuardContext = {
  callId: "call-1",
  ownerId: "42",
  sessionId: "session-1",
  turnId: "turn-1",
};

it("provides a deterministic fake guard for tool-level tests", async () => {
  const guard = createFakeCreationGuard(["automatic", "approval-request"]);

  await expect(guard.reserve(request)).resolves.toBe("automatic");
  await expect(guard.reserve({ ...request, callId: "call-2" })).resolves.toBe("approval-request");
  expect(guard.requests).toEqual([
    request,
    { ...request, callId: "call-2" },
  ]);
});

it("makes the provider-neutral decision shape explicit", async () => {
  const denied: CreationGuard = {
    reserve: async () => ({ type: "denied", reason: "one_creation_per_turn" }),
  };

  await expect(denied.reserve(request)).resolves.toEqual({
    type: "denied", reason: "one_creation_per_turn",
  });
});

it("uses one owner-scoped Upstash window across creation domains", async () => {
  const store = new FakeStore();
  const limit = async () => ({ success: true });
  const guard = createUpstashCreationGuard({ store, limiter: { limit } });

  await expect(guard.reserve(request)).resolves.toBe("automatic");
  await expect(guard.reserve({ ...request, callId: "event-call", sessionId: "event-session", turnId: "event-turn" }))
    .resolves.toBe("automatic");

  expect(store.writes).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: "bud:creation-guard:turn:session-1:turn-1", options: { ex: 600, nx: true } }),
    expect.objectContaining({ key: "bud:creation-guard:decision:call-1", options: { ex: 600 } }),
  ]));
});

it("expires durable turn reservations and the rolling Owner window after ten minutes", async () => {
  let now = 0;
  const store = new FakeStore(() => now);
  const reservations: number[] = [];
  const guard = createUpstashCreationGuard({ store, limiter: { async limit() {
    const start = now - 600_000;
    while (reservations[0] !== undefined && reservations[0] <= start) reservations.shift();
    reservations.push(now);
    return { success: reservations.length <= 10 };
  } } });

  for (let index = 0; index < 10; index += 1) {
    await expect(guard.reserve({ ...request, callId: `call-${index}`, turnId: `turn-${index}` }))
      .resolves.toBe("automatic");
  }
  await expect(guard.reserve({ ...request, callId: "limit-call", turnId: "limit-turn" }))
    .resolves.toBe("approval-request");
  now = 600_001;
  await expect(guard.reserve({ ...request, callId: "expired-call", turnId: "turn-0" }))
    .resolves.toBe("automatic");
});

it("is call-ID idempotent and permits only one creation reservation per turn", async () => {
  const store = new FakeStore();
  let releases!: () => void;
  const waiting = new Promise<void>((resolve) => { releases = resolve; });
  let calls = 0;
  const guard = createUpstashCreationGuard({ store, limiter: { async limit() {
    calls += 1;
    await waiting;
    return { success: true };
  } } });

  const first = guard.reserve(request);
  const replay = guard.reserve(request);
  releases();
  await expect(first).resolves.toBe("automatic");
  await expect(replay).resolves.toBe("automatic");
  await expect(guard.reserve({ ...request, callId: "call-2" })).resolves.toEqual({
    type: "denied", reason: "one_creation_per_turn",
  });
  expect(calls).toBe(1);
});

it("returns the original decision when another runtime re-evaluates a pending call ID", async () => {
  const store = new FakeStore();
  let entered!: () => void;
  const enteredLimit = new Promise<void>((resolve) => { entered = resolve; });
  let releases!: () => void;
  const waiting = new Promise<void>((resolve) => { releases = resolve; });
  const first = createUpstashCreationGuard({ store, limiter: { async limit() {
    entered();
    await waiting;
    return { success: true };
  } } });
  const second = createUpstashCreationGuard({ store, limiter: { async limit() {
    throw new Error("the duplicate must not consume a second slot");
  } } });

  const firstDecision = first.reserve(request);
  await enteredLimit;
  const replayDecision = second.reserve(request);
  releases();
  await expect(firstDecision).resolves.toBe("automatic");
  await expect(replayDecision).resolves.toBe("automatic");
});

it("allows ten automatic attempts in the shared Owner window before requesting approval", async () => {
  const store = new FakeStore();
  let attempts = 0;
  const guard = createUpstashCreationGuard({ store, limiter: { async limit() {
    attempts += 1;
    return { success: attempts <= 10 };
  } } });

  for (let index = 0; index < 10; index += 1) {
    await expect(guard.reserve({
      ...request, callId: `call-${index}`, sessionId: `session-${index}`, turnId: `turn-${index}`,
    })).resolves.toBe("automatic");
  }
  await expect(guard.reserve({
    ...request, callId: "call-11", sessionId: "session-11", turnId: "turn-11",
  })).resolves.toBe("approval-request");
});

it("fails safely to Approval Requests for missing, failed, timed-out, or malformed Upstash responses", async () => {
  await expect(createApprovalFallbackCreationGuard().reserve(request)).resolves.toBe("approval-request");
  await expect(createUpstashCreationGuard({}).reserve(request)).resolves.toBe("approval-request");
  await expect(createUpstashCreationGuard({ store: new FakeStore(), limiter: { async limit() { throw new Error("offline"); } } })
    .reserve(request)).resolves.toBe("approval-request");
  await expect(createUpstashCreationGuard({ store: new FakeStore(), limiter: { async limit() { return { success: true, reason: "timeout" }; } } })
    .reserve(request)).resolves.toBe("approval-request");
  await expect(createUpstashCreationGuard({ store: new FakeStore(), limiter: { async limit() { return { remaining: 9 }; } } })
    .reserve(request)).resolves.toBe("approval-request");
  const malformedStore = new FakeStore();
  malformedStore.seed("bud:creation-guard:decision:call-1", "not-json");
  let called = false;
  await expect(createUpstashCreationGuard({ store: malformedStore, limiter: { async limit() {
    called = true;
    return { success: true };
  } } }).reserve(request)).resolves.toBe("approval-request");
  expect(called).toBe(false);
});
