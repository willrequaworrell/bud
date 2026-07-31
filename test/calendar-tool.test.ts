import type { ToolContext } from "eve/tools";
import { expect, it, vi } from "vitest";

import { createListCalendarEventsTool } from "../agent/lib/calendar-tool.js";

function context(principalId: string): ToolContext {
  return { session: { auth: { current: { principalId } } } } as ToolContext;
}

it("lets the authenticated Owner read sourced Calendar events", async () => {
  const listEvents = vi.fn(async () => [
    { kind: "timed" as const, title: "Standup", source: "Work",
      start: "2026-07-30T13:00:00Z", end: "2026-07-30T13:30:00Z" },
    { kind: "all-day" as const, title: "Birthday", source: "Personal",
      startDate: "2026-07-30", endDate: "2026-07-31" },
  ]);
  const tool = createListCalendarEventsTool({
    adapter: { async getDefaultTimeZone() { return "America/New_York"; }, listEvents },
    now: () => new Date("2026-07-29T15:00:00.000Z"), ownerId: "42",
  });

  const result = await tool.execute(
    { period: { kind: "tomorrow" } }, context("telegram:42"),
  );

  expect(result).toMatchObject({
    status: "ok",
    events: [
      { title: "Birthday", source: "Personal" },
      { title: "Standup", source: "Work" },
    ],
    resolvedPeriod: {
      startDate: "2026-07-30", endDate: "2026-07-30", timeZone: "America/New_York",
    },
  });
  expect(listEvents).toHaveBeenCalledOnce();
});

it("re-enforces Owner authorization inside the Calendar tool", async () => {
  const listEvents = vi.fn(async () => []);
  const tool = createListCalendarEventsTool({
    adapter: { async getDefaultTimeZone() { return "UTC"; }, listEvents }, ownerId: "42",
  });

  expect(await tool.execute(
    { period: { kind: "today" } }, context("telegram:99"),
  )).toEqual({ status: "error", reason: "forbidden" });
  expect(listEvents).not.toHaveBeenCalled();
});
