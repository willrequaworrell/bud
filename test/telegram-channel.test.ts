import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import { createBudTelegramChannel } from "../agent/lib/telegram-channel.js";

const config: BudConfig = {
  assistantName: "Bud",
  modelId: "test/deterministic",
  ownerId: "42",
  telegramBotToken: "test-bot-token",
  telegramWebhookSecret: "test-webhook-secret",
};

interface CompiledTelegramChannel {
  adapter: {
    createAdapterContext(runtime: {
      state: TelegramChannelState;
      session: {
        continuationToken: string;
        setContinuationToken(token: string): void;
      };
      ctx: object;
    }): {
      telegram: { sendMessage(message: string): Promise<unknown> };
    };
  };
}

function telegramUpdate(input: {
  chatId: number;
  chatType: "group" | "private" | "supergroup";
  senderId: number;
  text: string;
}) {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: input.chatId, type: input.chatType },
      from: {
        id: input.senderId,
        is_bot: false,
        first_name: "Sender",
      },
      text: input.text,
    },
  };
}

async function deliver(update: unknown) {
  const outbound: Array<{ chatId: string; text: string }> = [];
  const telegramFetch = vi.fn<typeof fetch>(async (request, init) => {
    const body = JSON.parse(String(init?.body)) as {
      chat_id: string;
      text?: string;
    };
    if (String(request).endsWith("/sendMessage")) {
      outbound.push({ chatId: String(body.chat_id), text: body.text! });
    }
    return Response.json({
      ok: true,
      result: { message_id: 8, chat: { id: body.chat_id, type: "private" } },
    });
  });
  const model = vi.fn(async (message: string) => `Got it: ${message}`);
  const channel = createBudTelegramChannel(config, telegramFetch);
  const compiled = channel as typeof channel & CompiledTelegramChannel;
  const tasks: Promise<unknown>[] = [];

  const route = channel.routes[0];
  if (route?.transport !== "http") throw new Error("Telegram route is missing");

  const args = {
    send: vi.fn(async (input, options) => {
      const payload = input as { message: string };
      const reply = await model(payload.message);
      const channelContext = compiled.adapter.createAdapterContext({
        state: options.state as TelegramChannelState,
        session: {
          continuationToken: options.continuationToken,
          setContinuationToken: vi.fn(),
        },
        ctx: {},
      });
      await channelContext.telegram.sendMessage(reply);
      return { id: "test-session" } as Session;
    }),
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  const response = await route.handler(
    new Request("https://bud.test/eve/v1/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.telegramWebhookSecret,
      },
      body: JSON.stringify(update),
    }),
    args,
  );
  await Promise.all(tasks);

  return { model, outbound, response };
}

describe("Telegram Channel", () => {
  it("delivers the Owner's private text through Eve and sends the reply", async () => {
    const result = await deliver(
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "What is next?",
      }),
    );

    expect(result.response.status).toBe(200);
    expect(result.model).toHaveBeenCalledWith("What is next?");
    expect(result.outbound).toEqual([
      { chatId: "42", text: "Got it: What is next?" },
    ]);
  });

  it.each(["group", "supergroup"] as const)(
    "drops %s messages before model execution",
    async (chatType) => {
      const result = await deliver(
        telegramUpdate({
          chatId: -100,
          chatType,
          senderId: 42,
          text: "Hello Bud",
        }),
      );

      expect(result.model).not.toHaveBeenCalled();
      expect(result.outbound).toEqual([]);
    },
  );

  it("drops messages from other private senders before model execution", async () => {
    const result = await deliver(
      telegramUpdate({
        chatId: 99,
        chatType: "private",
        senderId: 99,
        text: "Hello Bud",
      }),
    );

    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([]);
  });
});
