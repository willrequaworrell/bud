import { describe, expect, it } from "vitest";

import { loadConfig } from "../agent/lib/config.js";

describe("configuration", () => {
  it("rejects missing required configuration without exposing secret values", () => {
    const secret = "123456:super-secret-token";

    expect(() =>
      loadConfig({
        TELEGRAM_BOT_TOKEN: secret,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
      }),
    ).toThrowError("TELEGRAM_OWNER_ID");

    try {
      loadConfig({ TELEGRAM_BOT_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("uses Bud and a balanced small model by default while allowing overrides", () => {
    const required = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(loadConfig(required)).toMatchObject({
      assistantName: "Bud",
      googleCalendarId: "primary",
      modelId: "openai/gpt-5.4-mini",
    });
    expect(
      loadConfig({
        ...required,
        BUD_ASSISTANT_NAME: "Sprout",
        BUD_MODEL_ID: "anthropic/claude-haiku-4.5",
      }),
    ).toMatchObject({
      assistantName: "Sprout",
      modelId: "anthropic/claude-haiku-4.5",
    });
  });

  it("requires Google OAuth credentials without exposing their values", () => {
    const secret = "google-client-secret-value";

    expect(() => loadConfig({
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: secret,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    })).toThrowError("GOOGLE_OAUTH_REFRESH_TOKEN");

    try {
      loadConfig({
        GOOGLE_OAUTH_CLIENT_SECRET: secret,
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_OWNER_ID: "42",
        TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
