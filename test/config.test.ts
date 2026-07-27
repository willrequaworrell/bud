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
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(loadConfig(required)).toMatchObject({
      assistantName: "Bud",
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
});
