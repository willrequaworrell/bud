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
      googleTasksListId: "@default",
      modelId: "openai/gpt-5.4-mini",
      tasksResultLimit: 25,
      transcriptionMaxBytes: 10 * 1024 * 1024,
      transcriptionMaxDurationSeconds: 5 * 60,
      transcriptionModel: "gpt-4o-mini-transcribe",
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

  it("accepts the current Upstash Marketplace REST integration without making automatic creation fail open", () => {
    const required = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(loadConfig({
      ...required,
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "upstash-token",
    })).toMatchObject({
      upstashRedis: { token: "upstash-token", url: "https://example.upstash.io" },
    });
    expect(loadConfig({ ...required, UPSTASH_REDIS_REST_URL: "https://example.upstash.io" }))
      .not.toHaveProperty("upstashRedis");
  });

  it("configures bounded voice-note transcription", () => {
    const required = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(loadConfig({
      ...required,
      BUD_TRANSCRIPTION_MODEL: "custom-transcriber",
      TELEGRAM_VOICE_MAX_BYTES: "2048",
      TELEGRAM_VOICE_MAX_DURATION_SECONDS: "45",
    })).toMatchObject({
      transcriptionMaxBytes: 2048,
      transcriptionMaxDurationSeconds: 45,
      transcriptionModel: "custom-transcriber",
    });
    expect(() => loadConfig({ ...required, TELEGRAM_VOICE_MAX_BYTES: "0" }))
      .toThrowError("TELEGRAM_VOICE_MAX_BYTES must be a positive integer");
    expect(() => loadConfig({ ...required, TELEGRAM_VOICE_MAX_DURATION_SECONDS: "1.5" }))
      .toThrowError("TELEGRAM_VOICE_MAX_DURATION_SECONDS must be a positive integer");
  });

  it("accepts only a high-entropy Siri capture token when the channel is enabled", () => {
    const required = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };
    const captureToken = "a".repeat(32);

    expect(loadConfig({ ...required, BUD_SIRI_CAPTURE_TOKEN: captureToken }))
      .toMatchObject({ siriCaptureToken: captureToken });
    expect(() => loadConfig({ ...required, BUD_SIRI_CAPTURE_TOKEN: "too-short" }))
      .toThrowError("BUD_SIRI_CAPTURE_TOKEN must contain at least 32 characters");
  });

  it("configures one Google Tasks list and a bounded result limit", () => {
    const required = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
      TELEGRAM_OWNER_ID: "42",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "webhook-secret",
    };

    expect(loadConfig({
      ...required,
      GOOGLE_TASKS_LIST_ID: "private-list-id",
      GOOGLE_TASKS_RESULT_LIMIT: "40",
    })).toMatchObject({
      googleTasksListId: "private-list-id",
      tasksResultLimit: 40,
    });
    expect(() => loadConfig({
      ...required,
      GOOGLE_TASKS_RESULT_LIMIT: "0",
    })).toThrowError("GOOGLE_TASKS_RESULT_LIMIT must be an integer from 1 to 100");
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
