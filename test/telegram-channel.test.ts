import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import {
  createBudTelegramChannel,
  handleTelegramInputRequested,
} from "../agent/lib/telegram-channel.js";

const config: BudConfig = {
  assistantName: "Bud", googleCalendarId: "primary", googleOAuthClientId: "client",
  googleCalendarReadIds: ["primary"],
  googleOAuthClientSecret: "secret", googleOAuthRefreshToken: "refresh",
  modelId: "test/deterministic", ownerId: "42", telegramBotToken: "bot",
  telegramWebhookSecret: "webhook",
};

function update(senderId: number, text: string, chatType: "private" | "group" = "private") {
  return { update_id: 1, message: { message_id: 7, date: 0,
    chat: { id: senderId, type: chatType },
    from: { id: senderId, is_bot: false, first_name: "Sender" }, text } };
}

function callbackUpdate(senderId: number, data: string) {
  return { update_id: 2, callback_query: { id: "callback-1", data,
    from: { id: senderId, is_bot: false, first_name: "Sender" },
    message: { message_id: 8, date: 0, chat: { id: senderId, type: "private" },
      from: { id: 100, is_bot: true, first_name: "Bud" }, text: "Approve?" } } };
}

async function deliverWithSessionState(
  activeSession: boolean,
  pendingProposal: boolean | "resolved",
  ...updates: unknown[]
) {
  const outbound: string[] = [];
  const authContexts: unknown[] = [];
  const model = vi.fn(async (message: string) => `Model: ${message}`);
  const telegramFetch = vi.fn<typeof fetch>(async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) outbound.push(body.text);
    return Response.json({ ok: true, result: { message_id: 8, chat: { id: 42, type: "private" } } });
  });
  const channel = createBudTelegramChannel(config, telegramFetch);
  const route = channel.routes[0]!;
  const tasks: Promise<unknown>[] = [];
  const args = {
    send: vi.fn(async (input, options) => {
      authContexts.push(options.auth);
      const payload = input as { message?: string; inputResponses?: Array<{ requestId: string }> };
      if (payload.inputResponses) {
        await (channel as any).adapter.deliver(payload, {
          state: options.state as TelegramChannelState,
          ctx: {},
          session: { continuationToken: options.continuationToken, setContinuationToken() {} },
        });
        return { id: "session" } as Session;
      }
      const reply = await model(payload.message!);
      const runtime = { state: options.state as TelegramChannelState, ctx: {}, session: {
        continuationToken: options.continuationToken, setContinuationToken() {},
      } };
      await (channel as any).adapter.createAdapterContext(runtime).telegram.sendMessage(reply);
      return { id: "session" } as Session;
    }),
    waitUntil(task: Promise<unknown>) { tasks.push(task); },
    async resolveActiveSession() { return activeSession ? { sessionId: "session" } : undefined; },
    getSession() {
      return { getEventStream: async () => new ReadableStream({ start(controller) {
        if (pendingProposal) {
          controller.enqueue({ type: "input.requested", data: { requests: [{
              action: { kind: "tool-call", toolName: "create_calendar_event", callId: "call", input: {} },
              requestId: "approval", prompt: "Approve?",
            }], sequence: 0, stepIndex: 0, turnId: "turn" } });
        }
        if (pendingProposal === "resolved") {
          controller.enqueue({ type: "action.result", data: {
            result: { kind: "tool-result", callId: "call", toolName: "create_calendar_event", output: {} },
            sequence: 0, stepIndex: 0, turnId: "turn", status: "completed",
          } });
        }
        controller.enqueue({ type: "session.waiting", data: {
          continuationToken: "token", wait: "next-user-message",
        } });
        controller.close();
      } }) } as Session;
    },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;
  for (const body of updates) {
    await route.handler(new Request("https://bud.test/eve/v1/telegram", {
      method: "POST", headers: { "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
      body: JSON.stringify(body),
    }), args);
    await Promise.all(tasks.splice(0));
  }
  return { authContexts, model, outbound };
}

async function deliverWithActiveSession(activeSession: boolean, ...updates: unknown[]) {
  return deliverWithSessionState(activeSession, activeSession, ...updates);
}

async function deliver(...updates: unknown[]) {
  return deliverWithActiveSession(false, ...updates);
}

describe("Telegram Channel", () => {
  it("shows Event details and conflict warnings in the approval prompt", async () => {
    const post = vi.fn(async () => ({ id: "message-1", raw: null }));
    const state = {} as TelegramChannelState;

    await handleTelegramInputRequested({ requests: [{
      action: {
        callId: "call-1",
        input: { proposal: {
          kind: "timed", title: "Dentist",
          startLocal: "2026-08-02T09:00", endLocal: "2026-08-02T09:30",
          timeZone: "America/New_York", location: "Dental Arts", description: null,
          warnings: [{ kind: "overlap", message: "Overlaps Team sync (Work)" }],
        } },
        kind: "tool-call", toolName: "create_calendar_event",
      },
      allowFreeform: false,
      display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve tool call: create_calendar_event",
      requestId: "approval-1",
    }] } as never, { state, telegram: { post } } as never, {} as never);

    expect(post).toHaveBeenCalledWith({
      reply_markup: { inline_keyboard: [[
        { callback_data: "eve:0", text: "Yes" },
        { callback_data: "eve:1", text: "No" },
      ]] },
      text: [
        "Create Calendar Event?",
        "",
        "Dentist",
        "When: 2026-08-02T09:00–2026-08-02T09:30 (America/New_York)",
        "Location: Dental Arts",
        "",
        "Warning: Overlaps Team sync (Work)",
      ].join("\n"),
    });
  });

  it("shows every warning before offering approval when the Proposal needs multiple messages", async () => {
    const post = vi.fn(async (_message: unknown) => ({ id: "message-1", raw: null }));
    const warnings = Array.from({ length: 80 }, (_, index) => ({
      kind: "overlap",
      message: `Overlaps conflict ${String(index).padStart(2, "0")} (${"Calendar".repeat(10)})`,
    }));

    await handleTelegramInputRequested({ requests: [{
      action: { callId: "call-1", kind: "tool-call", toolName: "create_calendar_event",
        input: { proposal: { kind: "all-day", title: "Retreat",
          startDate: "2026-08-02", throughDate: "2026-08-03", timeZone: "America/New_York",
          location: null, description: null, warnings } } },
      allowFreeform: false, display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve tool call: create_calendar_event", requestId: "approval-1",
    }] } as never, { state: {} as TelegramChannelState, telegram: { post } } as never, {} as never);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    const messages = post.mock.calls.map(([message]) => message as {
      reply_markup?: unknown; text: string;
    });
    for (const warning of warnings) {
      expect(messages.map(({ text }) => text).join("")).toContain(`Warning: ${warning.message}`);
    }
    expect(messages.slice(0, -1).every((message) => message.reply_markup === undefined)).toBe(true);
    expect(messages.at(-1)?.reply_markup).toBeDefined();
  });

  it("routes Calendar language through Eve instead of intercepting it", async () => {
    const result = await deliver(update(42, "What's on my calendar Thursday?"));
    expect(result.model).toHaveBeenCalledWith("What's on my calendar Thursday?");
    expect(result.outbound).toEqual(["Model: What's on my calendar Thursday?"]);
  });

  it("routes ordinary Owner messages through Eve", async () => {
    const result = await deliver(update(42, "What is next?"));
    expect(result.model).toHaveBeenCalledOnce();
    expect(result.outbound).toEqual(["Model: What is next?"]);
  });

  it("authenticates an Owner's native approval callback", async () => {
    const result = await deliver(callbackUpdate(42, "eve:0"));
    expect(result.authContexts).toEqual([
      expect.objectContaining({ principalId: "telegram:42" }),
    ]);
  });

  it("does not authenticate another sender's native approval callback", async () => {
    const result = await deliver(callbackUpdate(99, "eve:0"));
    expect(result.authContexts).toEqual([null]);
  });

  it.each([[99, "private"], [42, "group"]] as const)(
    "drops unauthorized sender/chat %#", async (sender, type) => {
      const result = await deliver(update(sender, "Hello", type));
      expect(result.model).not.toHaveBeenCalled();
      expect(result.outbound).toEqual([]);
    },
  );

  it("resets without sending the command to Eve", async () => {
    const result = await deliver(update(42, "/reset"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual(["Conversation reset."]);
  });

  it("resets an active conversation through Eve's pending-input path", async () => {
    const result = await deliverWithActiveSession(true, update(42, "/reset"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual(["Conversation reset."]);
  });

  it("refuses unrelated text while a Proposal approval is pending", async () => {
    const result = await deliverWithActiveSession(true, update(42, "What is the weather?"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
    ]);
  });

  it("does not label an ordinary active turn as a pending Proposal", async () => {
    const result = await deliverWithSessionState(true, false, update(42, "One more detail"));
    expect(result.model).toHaveBeenCalledWith("One more detail");
    expect(result.outbound).toEqual(["Model: One more detail"]);
  });

  it("does not treat a resolved Event approval in history as pending", async () => {
    const result = await deliverWithSessionState(true, "resolved", update(42, "Thanks"));
    expect(result.model).toHaveBeenCalledWith("Thanks");
    expect(result.outbound).toEqual(["Model: Thanks"]);
  });
});
