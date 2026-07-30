import {
  sendTelegramMessage,
  telegramChannel,
  type TelegramChannel,
  type TelegramChannelState,
  type TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs, Session } from "eve/channels";

import type { BudConfig } from "./config.js";
import { isOwnerPrivateText } from "./telegram-policy.js";

const RESET_REQUEST_PREFIX = "bud:conversation-reset:";

interface ResettableTelegramChannel {
  adapter: {
    createAdapterContext(ctx: ResetAdapterContext): {
      telegram: { sendMessage(message: string): Promise<unknown> };
    };
    deliver(payload: ResetPayload, ctx: ResetAdapterContext): unknown;
  };
  routes: Array<{
    handler(request: Request, args: RouteHandlerArgs<TelegramChannelState>): Promise<Response>;
    transport: string;
  }>;
}

interface ResetAdapterContext {
  ctx: object;
  session: {
    continuationToken: string;
    setContinuationToken(token: string): void;
  };
  state: TelegramChannelState;
}

interface ResetPayload {
  inputResponses?: ReadonlyArray<{ requestId: string }>;
  [key: string]: unknown;
}

function completedResetSession(resetRequestId: string): Session {
  return {
    id: resetRequestId,
    continuationToken: resetRequestId,
    async cancel() {
      return { status: "no_active_turn" };
    },
    async getEventStream() {
      return new ReadableStream();
    },
  };
}

function ownerAuth(message: TelegramMessage) {
  const user = message.from!;
  return {
    attributes: {
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      message_id: message.messageId,
      user_id: user.id,
    },
    authenticator: "telegram-webhook",
    issuer: "telegram",
    principalId: `telegram:${user.id}`,
    principalType: "user",
  } as const;
}

export function createBudTelegramChannel(
  channelConfig: BudConfig,
  telegramFetch?: typeof fetch,
): TelegramChannel {
  const channel = telegramChannel({
    ...(telegramFetch ? { api: { fetch: telegramFetch } } : {}),
    credentials: {
      botToken: channelConfig.telegramBotToken,
      webhookSecretToken: channelConfig.telegramWebhookSecret,
    },
    async onMessage(ctx, message) {
      if (!isOwnerPrivateText(message, channelConfig.ownerId)) {
        return null;
      }

      await ctx.telegram.startTyping();
      return { auth: ownerAuth(message) };
    },
  });
  const compiled = channel as typeof channel & ResettableTelegramChannel;

  const deliver = compiled.adapter.deliver.bind(compiled.adapter);
  compiled.adapter.deliver = async (payload, ctx) => {
    const resetRequestId = payload.inputResponses?.[0]?.requestId;
    if (resetRequestId?.startsWith(RESET_REQUEST_PREFIX)) {
      ctx.session.setContinuationToken(`reset:${crypto.randomUUID()}`);
      const telegram = compiled.adapter.createAdapterContext(ctx).telegram;
      await telegram.sendMessage("Conversation reset.");
      return;
    }
    return deliver(payload, ctx);
  };

  const route = compiled.routes[0];
  if (route?.transport !== "http") throw new Error("Telegram route is missing");
  const handleTelegramRequest = route.handler;
  route.handler = (request, args) =>
    handleTelegramRequest(request, {
      ...args,
      async send(input, options) {
        const message =
          typeof input === "object" && !Array.isArray(input) && "message" in input
            ? input.message
            : input;
        if (message !== "/reset") return args.send(input, options);

        const active = await args.resolveActiveSession({
          continuationToken: options.continuationToken,
        });
        const resetRequestId = `${RESET_REQUEST_PREFIX}${crypto.randomUUID()}`;
        if (!active) {
          await sendTelegramMessage({
            ...(telegramFetch ? { fetch: telegramFetch } : {}),
            body: { text: "Conversation reset." },
            chatId: options.state.chatId!,
            credentials: { botToken: channelConfig.telegramBotToken },
          });
          return completedResetSession(resetRequestId);
        }

        return args.send(
          { inputResponses: [{ requestId: resetRequestId }] },
          options,
        );
      },
    });

  return channel;
}
