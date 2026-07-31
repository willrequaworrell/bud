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
      googleCalendarReadIds: ["primary"],
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

  it("parses a unique ordered Calendar Read Set independently of the Write Calendar", () => {
    const config = loadConfig({
      GOOGLE_CALENDAR_ID: "write@example.com",
      GOOGLE_CALENDAR_READ_IDS: " work@example.com,personal@example.com,work@example.com ",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    });

    expect(config.googleCalendarId).toBe("write@example.com");
    expect(config.googleCalendarReadIds).toEqual([
      "work@example.com",
      "personal@example.com",
    ]);
  });

  it("rejects more than 10 Read Calendars without exposing their IDs", () => {
    const ids = Array.from({ length: 11 }, (_, index) => `private-${index}@example.com`);
    const environment = {
      GOOGLE_CALENDAR_READ_IDS: ids.join(","),
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(() => loadConfig(environment)).toThrowError(
      "GOOGLE_CALENDAR_READ_IDS supports at most 10 calendars",
    );
    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain(ids[0]);
    }
  });

  it("rejects an explicitly empty Calendar Read Set", () => {
    expect(() => loadConfig({
      GOOGLE_CALENDAR_READ_IDS: " , ",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    })).toThrowError("GOOGLE_CALENDAR_READ_IDS must contain at least one calendar");
  });

  it("accepts exactly 10 unique Read Calendars", () => {
    const googleCalendarReadIds = Array.from(
      { length: 10 },
      (_, index) => `calendar-${index}@example.com`,
    );
    const config = loadConfig({
      GOOGLE_CALENDAR_READ_IDS: googleCalendarReadIds.join(","),
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    });

    expect(config.googleCalendarReadIds).toEqual(googleCalendarReadIds);
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
