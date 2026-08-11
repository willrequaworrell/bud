import type { RouteHandlerArgs } from "eve/channels";
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import { createFakeCreationGuard } from "../agent/lib/creation-guard.js";
import { createSiriCaptureChannel } from "../agent/lib/siri-capture-channel.js";
import { createCreateTaskTool, createPrepareTaskTool } from "../agent/lib/tasks-tool.js";

type CaptureRouteArgs = RouteHandlerArgs<{} | undefined>;

const captureToken = "capture-token-that-is-at-least-thirty-two-characters";
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

  it("rejects empty capture text before starting a Conversation turn", async () => {
    const channel = createSiriCaptureChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "   " }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_message" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects capture text longer than 2,000 characters", async () => {
    const channel = createSiriCaptureChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "a".repeat(2_001) }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "message_too_long" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    const channel = createSiriCaptureChannel(config, {} as never);
    const receive = vi.fn();
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Do not accept this" }),
    }), {
      receive,
      waitUntil: vi.fn(),
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("accepts authenticated text into the Owner's Telegram Conversation", async () => {
    const telegram = {} as never;
    const channel = createSiriCaptureChannel(config, telegram);
    const receive = vi.fn(async () => undefined);
    const backgroundTasks: Promise<unknown>[] = [];
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Remind me to buy furnace filters" }),
    }), {
      receive,
      waitUntil(task: Promise<unknown>) {
        backgroundTasks.push(task);
      },
    } as unknown as CaptureRouteArgs) as Response;

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      acknowledgement: "Got it. I sent that to Bud.",
      status: "accepted",
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
      target: { chatId: "42" },
    });
    expect(backgroundTasks).toHaveLength(1);
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
    });
    const backgroundTasks: Promise<unknown>[] = [];
    const channel = createSiriCaptureChannel(config, telegram);
    const route = channel.routes[0]!;

    const response = await route.handler(new Request("https://bud.test/eve/v1/siri", {
      method: "POST",
      headers: {
        authorization: `Bearer ${captureToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "Create task: Siri channel task" }),
    }), {
      receive,
      waitUntil(task: Promise<unknown>) { backgroundTasks.push(task); },
    } as unknown as CaptureRouteArgs) as Response;
    await Promise.all(backgroundTasks);

    expect(response.status).toBe(202);
    expect(receive).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledWith({
      title: "Siri channel task", notes: null, dueDate: null, idempotencyKey: "siri-create-call",
    });
  });
});
