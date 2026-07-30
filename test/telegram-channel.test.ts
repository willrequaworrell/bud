import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import { createBudTelegramChannel } from "../agent/lib/telegram-channel.js";

const config: BudConfig = {
  assistantName: "Bud", googleCalendarId: "primary", googleOAuthClientId: "client",
  googleOAuthClientSecret: "secret", googleOAuthRefreshToken: "refresh",
  modelId: "test/deterministic", ownerId: "42", telegramBotToken: "bot",
  telegramWebhookSecret: "webhook",
};

function update(senderId: number, text: string, chatType: "private" | "group" = "private") {
  return { update_id: 1, message: { message_id: 7, date: 0,
    chat: { id: senderId, type: chatType },
    from: { id: senderId, is_bot: false, first_name: "Sender" }, text } };
}

async function deliverWithActiveSession(activeSession: boolean, ...updates: unknown[]) {
  const outbound: string[] = [];
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
  } as unknown as RouteHandlerArgs<TelegramChannelState>;
  for (const body of updates) {
    await route.handler(new Request("https://bud.test/eve/v1/telegram", {
      method: "POST", headers: { "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
      body: JSON.stringify(body),
    }), args);
    await Promise.all(tasks.splice(0));
  }
  return { model, outbound };
}

async function deliver(...updates: unknown[]) {
  return deliverWithActiveSession(false, ...updates);
}

describe("Telegram Channel", () => {
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
});
