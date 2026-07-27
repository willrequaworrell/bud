import {
  telegramChannel,
  type TelegramChannel,
  type TelegramMessage,
} from "eve/channels/telegram";

import type { BudConfig } from "./config.js";
import { isOwnerPrivateText } from "./telegram-policy.js";

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
  return telegramChannel({
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
}
