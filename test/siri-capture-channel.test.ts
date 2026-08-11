import type { RouteHandlerArgs } from "eve/channels";
import type { Session } from "eve/channels";
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import { createFakeCreationGuard } from "../agent/lib/creation-guard.js";
import { createSiriCaptureChannel, type SiriInvocationStore } from "../agent/lib/siri-capture-channel.js";
import { createCreateTaskTool, createPrepareTaskTool } from "../agent/lib/tasks-tool.js";

type CaptureRouteArgs = RouteHandlerArgs<{} | undefined>;

const captureToken = "capture-token-that-is-at-least-thirty-two-characters";
const requestId = "a3c00f6c-84b5-4bc4-998b-6a9e1f5df622";
const config: BudConfig = {
  assistantName: "Bud",
  googleCalendarId: "primary",
  googleCalendarReadIds: ["primary"],
  googleOAuthClientId: "client",
  googleOAuthClientSecret: "secret",
  googleOAuthRefreshToken: "refresh",
  googleTasksListId: "@default",
  modelId: "test/deterministic",
  ownerId: "42",
  siriCaptureToken: captureToken,
  tasksResultLimit: 25,
  telegramBotToken: "bot",
  telegramWebhookSecret: "webhook",
  transcriptionMaxBytes: 10 * 1024 * 1024,
  transcriptionMaxDurationSeconds: 5 * 60,
  transcriptionModel: "test-transcriber",
};

function session(...events: unknown[]): Session {
  return {
    id: "siri-session", continuationToken: "telegram:42",
    async cancel() { return { status: "no_active_turn" }; },
    async getEventStream() {
      return new ReadableStream({ start(controller) {
        for (const event of events) controller.enqueue(event as never);
        controller.close();
      } });
    },
  } as Session;
}

function completion(message: string) {
  return session(
    { type: "message.completed", data: { finishReason: "stop", message } },
    { type: "turn.completed", data: { turnId: "turn" } },
  );
}

function createMemoryStore(): SiriInvocationStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key); },
    async set(key, value, options) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
  };
}

function createTestSiriChannel(channelConfig: BudConfig, telegram: never, deadlineMilliseconds?: number) {
  return createSiriCaptureChannel(channelConfig, telegram, {
    invocationStore: createMemoryStore(),
    ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
  });
}

describe("Siri capture HTTP channel", () => {
  it("is unavailable until a capture token is configured", async () => {
    const { siriCaptureToken: _removed, ...disabledConfig } = config;
    const channel = createSiriCaptureChannel(disabledConfig, {} as never);
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: "Bearer undefined",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "This must not be accepted" }),
    }), {} as CaptureRouteArgs) as Response;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "capture_not_configured" });
  });

  it("requires durable replay storage when capture is enabled", async () => {
    const channel = createSiriCaptureChannel(config, {} as never);
    const response = await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Do not start a non-durable turn", requestId }),
    }), {} as CaptureRouteArgs) as Response;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "capture_not_configured" });
  });

  it("accepts a UUIDv7 invocation ID from Shortcuts", async () => {
    const channel = createTestSiriChannel(config, {} as never);
    const response = await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: "Read my calendar", requestId: "0198427d-f8c4-7d30-8c46-669bba1b8792",
      }),
    }), { receive: vi.fn(async () => completion("Your calendar is clear.")) } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      speech: "Your calendar is clear.", status: "completed",
    });
  });

  it("rejects empty capture text before starting a Conversation turn", async () => {
    const channel = createTestSiriChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "   ", requestId }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_message" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects capture text longer than 2,000 characters", async () => {
    const channel = createTestSiriChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "a".repeat(2_001), requestId }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "message_too_long" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    const channel = createTestSiriChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Do not accept this", requestId }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("mirrors authenticated text and speaks a completed Telegram Conversation result", async () => {
    const telegram = {} as never;
    const channel = createTestSiriChannel(config, telegram);
    const receive = vi.fn(async () => completion("I will remind you about furnace filters."));
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Remind me to buy furnace filters", requestId }),
    }), {
      receive,
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      speech: "I will remind you about furnace filters.", status: "completed",
    });
    expect(receive).toHaveBeenCalledWith(telegram, {
      auth: {
        attributes: {
          capture_source: "siri-shortcut",
          chat_id: "42",
          chat_type: "private",
          user_id: "42",
        },
        authenticator: "siri-shortcut",
        issuer: "bud",
        principalId: "telegram:42",
        principalType: "user",
      },
      message: "Remind me to buy furnace filters",
      target: { chatId: "42", initialMessage: "🎙 You via Siri: Remind me to buy furnace filters" },
    });
  });

  it("returns a Telegram handoff for a long response without truncating it", async () => {
    const receive = vi.fn(async () => completion("x".repeat(801)));
    const channel = createTestSiriChannel(config, {} as never);
    const response = await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Tell me everything", requestId }),
    }), { receive } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      speech: "Bud has a longer response in Telegram.", status: "pending",
    });
  });

  it("returns pending at the deadline without cancelling the continuing Eve turn", async () => {
    let controller: ReadableStreamDefaultController<unknown> | undefined;
    const stream = new ReadableStream<unknown>({ start(value) { controller = value; } });
    const receive = vi.fn(async () => ({
      id: "siri-session", continuationToken: "telegram:42",
      async cancel() { throw new Error("Siri observation must not cancel the turn"); },
      async getEventStream() { return stream as never; },
    } as Session));
    const channel = createTestSiriChannel(config, {} as never, 1);
    const response = await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Slow request", requestId }),
    }), { receive } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      speech: "Bud is continuing in Telegram.", status: "pending",
    });
    expect(stream.locked).toBe(true);
    controller!.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(stream.locked).toBe(false);
  });

  it("speaks a prompt provider failure", async () => {
    const receive = vi.fn(async () => session({
      type: "turn.failed", data: { message: "Google Tasks is unavailable." },
    }));
    const channel = createTestSiriChannel(config, {} as never);
    const response = await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Create task", requestId }),
    }), { receive } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      speech: "Bud couldn't complete that: Google Tasks is unavailable.", status: "completed",
    });
  });

  it("returns the durable outcome for a duplicate request UUID without another turn", async () => {
    const receive = vi.fn(async () => completion("Task created."));
    const channel = createTestSiriChannel(config, {} as never);
    const route = channel.routes[0]!;
    const request = () => new Request("https://bud.test/eve/v1/siri", {
      method: "POST", headers: { authorization: `Bearer ${captureToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "Create task: filters", requestId }),
    });

    const first = await route.handler(request(), { receive } as unknown as CaptureRouteArgs) as Response;
    const retry = await route.handler(request(), { receive } as unknown as CaptureRouteArgs) as Response;

    await expect(first.json()).resolves.toEqual({ speech: "Task created.", status: "completed" });
    await expect(retry.json()).resolves.toEqual({ speech: "Task created.", status: "completed" });
    expect(receive).toHaveBeenCalledOnce();
  });

  it("automatically creates one Prepared Task from an authenticated Siri request", async () => {
    const createTask = vi.fn(async () => ({ taskId: "task-1" }));
    const adapter = { createTask, async listIncomplete() { return { tasks: [], truncated: false }; } };
    const prepare = createPrepareTaskTool({ adapter, ownerId: config.ownerId });
    const create = createCreateTaskTool({
      adapter, guard: createFakeCreationGuard(["automatic"]), ownerId: config.ownerId,
    });
    const telegram = {} as never;
    const receive = vi.fn(async (_channel, input: {
      auth: { principalId: string };
      message: string;
    }) => {
      expect(input.message).toBe("Create task: Siri channel task");
      const toolContext = {
        callId: "siri-create-call", session: {
          id: "siri-session", auth: { current: { principalId: input.auth.principalId } },
          turn: { id: "siri-turn" },
        },
      } as ToolContext;
      const prepared = await prepare.execute({ title: "Siri channel task" }, toolContext);
      if (prepared.status !== "ok") throw new Error("expected Prepared Task");
      await expect(create.approval!(toolContext as never)).resolves.toBe("not-applicable");
      await expect(create.execute({ preparedTask: prepared.preparedTask }, toolContext))
        .resolves.toEqual({ status: "ok", taskId: "task-1" });
      return completion("Task created.");
    });
    const channel = createTestSiriChannel(config, telegram);
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Create task: Siri channel task", requestId }),
    }), {
      receive,
    } as unknown as CaptureRouteArgs) as Response;
    expect(response.status).toBe(200);
    expect(receive).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledWith({
      title: "Siri channel task", notes: null, dueDate: null, idempotencyKey: "siri-create-call",
    });
  });
});
