import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import { createBudTelegramChannel } from "../agent/lib/telegram-channel.js";
import {
  PersonalOrganizerError,
  type PersonalOrganizer,
  type PersonalOrganizerFailure,
} from "../agent/lib/personal-organizer.js";

const config: BudConfig = {
  assistantName: "Bud",
  googleCalendarId: "primary",
  googleOAuthClientId: "test-client-id",
  googleOAuthClientSecret: "test-client-secret",
  googleOAuthRefreshToken: "test-refresh-token",
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
    deliver: (
      payload: { inputResponses?: Array<{ requestId: string }> },
      runtime: {
        state: TelegramChannelState;
        session: {
          continuationToken: string;
          setContinuationToken(token: string): void;
        };
        ctx: object;
      },
    ) => Promise<unknown>;
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

async function deliverWithOrganizer(
  organizer: PersonalOrganizer | undefined,
  ...updates: unknown[]
) {
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
  const conversations = new Map<string, string[]>();
  const model = vi.fn(async (message: string, history: readonly string[]) => {
    if (message === "Schedule it") return "What day should I schedule it?";
    if (message === "Tomorrow" && history.includes("Schedule it")) {
      return "Okay, I'll schedule it tomorrow.";
    }
    return `Got it: ${message}`;
  });
  const channel = createBudTelegramChannel(config, telegramFetch, {
    ...(organizer ? { organizer } : {}),
    now: () => new Date("2026-07-28T15:00:00.000Z"),
  });
  const compiled = channel as typeof channel & CompiledTelegramChannel;
  const tasks: Promise<unknown>[] = [];

  const route = channel.routes[0];
  if (route?.transport !== "http") throw new Error("Telegram route is missing");

  const args = {
    send: vi.fn(async (input, options) => {
      const payload = input as {
        inputResponses?: Array<{ requestId: string }>;
        message?: string;
      };
      if (payload.inputResponses) {
        let deliveryError: unknown;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          let continuationToken = options.continuationToken;
          try {
            await compiled.adapter.deliver(payload, {
              state: options.state as TelegramChannelState,
              session: {
                continuationToken,
                setContinuationToken(token: string) {
                  continuationToken = token;
                  const history = conversations.get(options.continuationToken);
                  if (history) conversations.set(token, history);
                  conversations.delete(options.continuationToken);
                },
              },
              ctx: {},
            });
            return { id: "test-session" } as Session;
          } catch (error) {
            deliveryError = error;
          }
        }
        throw deliveryError;
      }
      const message = payload.message!;
      const history = conversations.get(options.continuationToken) ?? [];
      const reply = await model(message, [...history]);
      history.push(message);
      conversations.set(options.continuationToken, history);
      let continuationToken = options.continuationToken;
      const channelContext = compiled.adapter.createAdapterContext({
        state: options.state as TelegramChannelState,
        session: {
          continuationToken: options.continuationToken,
          setContinuationToken(token: string) {
            continuationToken = token;
          },
        },
        ctx: {},
      });
      await channelContext.telegram.sendMessage(reply);
      if (continuationToken !== options.continuationToken) {
        conversations.set(continuationToken, history);
        conversations.delete(options.continuationToken);
      }
      return { id: "test-session" } as Session;
    }),
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
    async resolveActiveSession(options: { continuationToken: string }) {
      return conversations.has(options.continuationToken)
        ? { sessionId: "test-session" }
        : undefined;
    },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;

  let response: Response | undefined;
  for (const update of updates) {
    response = await route.handler(
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
    await Promise.all(tasks.splice(0));
  }

  return { model, outbound, response: response! };
}

async function deliver(...updates: unknown[]) {
  return deliverWithOrganizer(undefined, ...updates);
}

describe("Telegram Channel", () => {
  it("answers an unqualified calendar request with the remainder of today", async () => {
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      async listEvents(range) {
        expect(range).toEqual({
          end: "2026-07-29T04:00:00.000Z",
          start: "2026-07-28T15:00:00.000Z",
          timeZone: "America/New_York",
        });
        return [];
      },
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "What's on my calendar?",
      }),
    );

    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      { chatId: "42", text: "Your calendar is clear for the rest of today." },
    ]);
  });

  it("formats populated calendar results in the Calendar timezone", async () => {
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      async listEvents() {
        return [
          {
            end: "2026-07-28T16:00:00.000Z",
            start: "2026-07-28T15:30:00.000Z",
            title: "Dentist",
          },
        ];
      },
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "My agenda" }),
    );

    expect(result.outbound).toEqual([
      { chatId: "42", text: "11:30 AM–12:00 PM — Dentist" },
    ]);
  });

  it("formats date-only events as all-day events", async () => {
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      async listEvents() {
        return [{ end: "2026-07-31", start: "2026-07-30", title: "Vacation" }];
      },
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "My agenda" }),
    );

    expect(result.outbound).toEqual([
      { chatId: "42", text: "All day — Vacation" },
    ]);
  });

  it("uses explicit bounded dates instead of the remainder of today", async () => {
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      async listEvents(range) {
        expect(range).toEqual({
          end: "2026-07-31T04:00:00.000Z",
          start: "2026-07-30T04:00:00.000Z",
          timeZone: "America/New_York",
        });
        return [];
      },
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "What's on my calendar July 30?",
      }),
    );

    expect(result.outbound).toEqual([
      { chatId: "42", text: "Your calendar is clear for that time." },
    ]);
  });

  it("honors an explicit timezone across a daylight-saving date range", async () => {
    const listEvents = vi.fn(async () => []);
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      listEvents,
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "Show my calendar March 7 to March 9 in America/Los_Angeles",
      }),
    );

    expect(listEvents).toHaveBeenCalledWith({
      end: "2026-03-10T07:00:00.000Z",
      start: "2026-03-07T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
    });
    expect(result.outbound).toEqual([
      { chatId: "42", text: "Your calendar is clear for that time." },
    ]);
  });

  it("honors timezones with fractional-hour offsets", async () => {
    const listEvents = vi.fn(async () => []);
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      listEvents,
    };

    await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "Show my calendar 2026-07-30 in Asia/Kathmandu",
      }),
    );

    expect(listEvents).toHaveBeenCalledWith({
      end: "2026-07-30T18:15:00.000Z",
      start: "2026-07-29T18:15:00.000Z",
      timeZone: "Asia/Kathmandu",
    });
  });

  it("treats today through tomorrow as an inclusive date range", async () => {
    const listEvents = vi.fn(async () => []);
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      listEvents,
    };

    await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "Show my calendar today through tomorrow",
      }),
    );

    expect(listEvents).toHaveBeenCalledWith({
      end: "2026-07-30T04:00:00.000Z",
      start: "2026-07-28T04:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it("rolls yearless ranges into the next year and accepts multi-segment timezones", async () => {
    const listEvents = vi.fn(async () => []);
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        return "America/New_York";
      },
      listEvents,
    };

    await deliverWithOrganizer(
      organizer,
      telegramUpdate({
        chatId: 42,
        chatType: "private",
        senderId: 42,
        text: "Show my calendar December 31 to January 1 in America/Argentina/Buenos_Aires",
      }),
    );

    expect(listEvents).toHaveBeenCalledWith({
      end: "2027-01-02T03:00:00.000Z",
      start: "2026-12-31T03:00:00.000Z",
      timeZone: "America/Argentina/Buenos_Aires",
    });
  });

  it.each<[PersonalOrganizerFailure, string]>([
    ["access-revoked", "Google Calendar access was revoked. Please reconnect it."],
    ["authentication-expired", "Google Calendar authentication expired. Please reconnect it."],
    ["rate-limited", "Google Calendar is busy right now. Please try again shortly."],
    ["unavailable", "Google Calendar is unavailable right now. Please try again later."],
  ])("returns a safe response when organizer access is %s", async (reason, response) => {
    const organizer: PersonalOrganizer = {
      async getDefaultTimeZone() {
        throw new PersonalOrganizerError(reason);
      },
      async listEvents() {
        return [];
      },
    };

    const result = await deliverWithOrganizer(
      organizer,
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "My calendar" }),
    );

    expect(result.outbound).toEqual([{ chatId: "42", text: response }]);
    expect(JSON.stringify(result.outbound)).not.toContain("test-bot-token");
  });

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
    expect(result.model).toHaveBeenCalledWith("What is next?", []);
    expect(result.outbound).toEqual([
      { chatId: "42", text: "Got it: What is next?" },
    ]);
  });

  it("continues the Owner's conversation so a clarification can be resolved", async () => {
    const result = await deliver(
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "Schedule it" }),
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "Tomorrow" }),
    );

    expect(result.outbound).toEqual([
      { chatId: "42", text: "What day should I schedule it?" },
      { chatId: "42", text: "Okay, I'll schedule it tomorrow." },
    ]);
  });

  it("resets conversational and pending input state without touching external data", async () => {
    const result = await deliver(
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "Schedule it" }),
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "/reset" }),
      telegramUpdate({ chatId: 42, chatType: "private", senderId: 42, text: "Tomorrow" }),
    );

    expect(result.outbound).toEqual([
      { chatId: "42", text: "What day should I schedule it?" },
      { chatId: "42", text: "Conversation reset." },
      { chatId: "42", text: "Got it: Tomorrow" },
    ]);
    expect(result.model).toHaveBeenCalledTimes(2);
    expect(result.model).not.toHaveBeenCalledWith("/reset", expect.anything());
  });

  it("stays reactive and sends nothing without an inbound update", async () => {
    const result = await deliver();

    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([]);
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
