import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { mockModel } from "eve/evals";
import type { ToolContext } from "eve/tools";
import { generateText, stepCountIs, tool as modelTool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BudConfig } from "../agent/lib/config.js";
import { createListCalendarEventsTool } from "../agent/lib/calendar-tool.js";
import type { CalendarAdapter, CalendarPeriod } from "../agent/lib/calendar.js";
import { createBudTelegramChannel } from "../agent/lib/telegram-channel.js";

const config: BudConfig = {
  assistantName: "Bud", googleCalendarId: "primary", googleCalendarReadIds: ["primary"],
  googleOAuthClientId: "client", googleOAuthClientSecret: "secret",
  googleOAuthRefreshToken: "refresh", googleTasksListId: "@default",
  modelId: "test/deterministic", ownerId: "42", tasksResultLimit: 25,
  telegramBotToken: "bot", telegramWebhookSecret: "webhook",
  transcriptionMaxBytes: 10 * 1024 * 1024,
  transcriptionMaxDurationSeconds: 5 * 60,
  transcriptionModel: "test-transcriber",
};

function renderEvents(result: {
  events?: ReadonlyArray<{ title: string }>;
  resolvedPeriod?: { startDate: string; timeZone: string };
}) {
  const period = result.resolvedPeriod!;
  return [
    `${period.startDate} (${period.timeZone})`,
    ...(result.events?.map((event) => `- ${event.title}`) ?? []),
  ].join("\n");
}

async function askCalendar(message: string) {
  const requestedRanges: Array<{ start: string }> = [];
  const outbound: string[] = [];
  const adapter: CalendarAdapter = {
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents(range) {
      requestedRanges.push(range);
      const events = [
        { kind: "timed" as const, title: "Morning standup", source: "Work",
          start: "2026-08-04T13:00:00Z", end: "2026-08-04T13:30:00Z" },
        { kind: "timed" as const, title: "Afternoon review", source: "Work",
          start: "2026-08-04T19:00:00Z", end: "2026-08-04T19:30:00Z" },
      ];
      return events.filter((event) => event.end > range.start);
    },
  };
  const calendarTool = createListCalendarEventsTool({
    adapter, now: () => new Date("2026-08-04T16:00:00Z"), ownerId: "42",
  });
  const model = mockModel(({ lastUserMessage, toolResults, tools }) => {
    if (toolResults.length > 0) return renderEvents(toolResults.at(-1)!.output as never);
    const description = tools.find(({ name }) => name === "list_calendar_events")?.description ?? "";
    const asksForRemaining = /\b(left|remaining|rest)\b/i.test(lastUserMessage ?? "");
    const documentsRemainingPeriod = /left|remaining|rest/i.test(description) &&
      description.includes("remainder-of-today");
    const period: CalendarPeriod = asksForRemaining && documentsRemainingPeriod
      ? { kind: "remainder-of-today" }
      : { kind: "today" };
    return { toolCalls: [{ input: { period }, name: "list_calendar_events" }] };
  });
  const telegramFetch = vi.fn<typeof fetch>(async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) outbound.push(body.text);
    return Response.json({ ok: true, result: { message_id: 8, chat: { id: 42, type: "private" } } });
  });
  const channel = createBudTelegramChannel(config, { telegramFetch });
  const pending: Promise<unknown>[] = [];
  const args = {
    async send(input: unknown, options: { state: TelegramChannelState }) {
      const result = await generateText({
        model,
        prompt: (input as { message: string }).message,
        stopWhen: stepCountIs(2),
        tools: {
          list_calendar_events: modelTool({
            description: calendarTool.description,
            inputSchema: z.object({
              period: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("remainder-of-today") }),
                z.object({ kind: z.literal("today") }),
              ]),
            }),
            execute: (toolInput) => calendarTool.execute(toolInput, {
              callId: "call", session: { auth: { current: { principalId: "telegram:42" } } },
            } as ToolContext),
          }),
        },
      });
      await (channel as any).adapter.createAdapterContext({
        ctx: {}, session: { continuationToken: "token", setContinuationToken() {} },
        state: options.state,
      }).telegram.sendMessage(result.text);
      return { id: "session" } as Session;
    },
    waitUntil(task: Promise<unknown>) { pending.push(task); },
    async resolveActiveSession() { return undefined; },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;
  await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/telegram", {
    method: "POST",
    headers: { "content-type": "application/json",
      "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 7, date: 0,
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Owner" },
      text: message } }),
  }), args);
  await Promise.all(pending);
  return { outbound, requestedRanges };
}

describe("Calendar through the Telegram Channel", () => {
  it.each([
    "What is left on my calendar today?",
    "What is remaining today?",
    "What is on my calendar for the rest of today?",
  ])("shows only Events that have not ended for: %s", async (message) => {
    const result = await askCalendar(message);

    expect(result.requestedRanges).toEqual([
      expect.objectContaining({ start: "2026-08-04T16:00:00.000Z" }),
    ]);
    expect(result.outbound).toEqual([
      "2026-08-04 (America/New_York)\n- Afternoon review",
    ]);
  });

  it("still shows the whole day when the Owner explicitly asks for everything", async () => {
    const result = await askCalendar("Show me everything on my calendar today");

    expect(result.requestedRanges).toEqual([
      expect.objectContaining({ start: "2026-08-04T04:00:00.000Z" }),
    ]);
    expect(result.outbound).toEqual([
      "2026-08-04 (America/New_York)\n- Morning standup\n- Afternoon review",
    ]);
  });
});
