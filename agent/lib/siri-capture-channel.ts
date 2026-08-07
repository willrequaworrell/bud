import { defineChannel, POST } from "eve/channels";
import type { TelegramChannel } from "eve/channels/telegram";

import type { BudConfig } from "./config.js";

export function createSiriCaptureChannel(
  config: BudConfig,
  telegram: TelegramChannel,
) {
  return defineChannel({
    state: {},
    routes: [
      POST("/eve/v1/siri", async (request, { receive, waitUntil }) => {
        if (!config.siriCaptureToken) {
          return Response.json({ error: "capture_not_configured" }, { status: 503 });
        }
        if (request.headers.get("authorization") !== `Bearer ${config.siriCaptureToken}`) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        const body = await request.json().catch(() => undefined) as
          | { message?: unknown }
          | undefined;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          return Response.json({ error: "invalid_message" }, { status: 400 });
        }
        if (message.length > 2_000) {
          return Response.json({ error: "message_too_long" }, { status: 413 });
        }
        waitUntil(receive(telegram, {
          auth: {
            attributes: {
              capture_source: "siri-shortcut",
              chat_id: config.ownerId,
              chat_type: "private",
              user_id: config.ownerId,
            },
            authenticator: "siri-shortcut",
            issuer: "bud",
            principalId: `telegram:${config.ownerId}`,
            principalType: "user",
          },
          message,
          target: { chatId: config.ownerId },
        }));

        return Response.json({
          acknowledgement: "Got it. I sent that to Bud.",
          status: "accepted",
        }, { status: 202 });
      }),
    ],
  });
}
