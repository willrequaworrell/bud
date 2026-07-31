import { expect, it, vi } from "vitest";

import {
  CalendarAdapterError,
  createCalendar,
  type CalendarAdapter,
} from "../agent/lib/calendar.js";

it("reads an exact local date through the configured Calendar timezone", async () => {
  const listEvents = vi.fn(async () => [
    {
      kind: "timed" as const,
      end: "2026-07-30T14:15:00.000Z",
      source: "Work",
      start: "2026-07-30T13:00:00.000Z",
      title: "Test event",
    },
  ]);
  const adapter: CalendarAdapter = {
    async getDefaultTimeZone() {
      return "America/New_York";
    },
    listEvents,
  };
  const calendar = createCalendar(adapter, {
    now: () => new Date("2026-07-29T03:42:00.000Z"),
  });

  const result = await calendar.listEvents({
    period: { kind: "date", date: "2026-07-30" },
  });

  expect(listEvents).toHaveBeenCalledWith({
    end: "2026-07-31T04:00:00.000Z",
    start: "2026-07-30T04:00:00.000Z",
    timeZone: "America/New_York",
  });
  expect(result).toEqual({
    status: "ok",
    events: [
      {
        kind: "timed",
        end: "2026-07-30T14:15:00.000Z",
        source: "Work",
        start: "2026-07-30T13:00:00.000Z",
        title: "Test event",
      },
    ],
    resolvedPeriod: {
      end: "2026-07-31T04:00:00.000Z",
      endDate: "2026-07-30",
      start: "2026-07-30T04:00:00.000Z",
      startDate: "2026-07-30",
      timeZone: "America/New_York",
    },
  });
});

it("preserves the resolved period when a provider read fails", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { throw new CalendarAdapterError("rate_limited"); },
  }, { now: () => new Date("2026-07-29T15:00:00.000Z") });

  expect(await calendar.listEvents({ period: { kind: "tomorrow" } })).toEqual({
    status: "error",
    reason: "rate_limited",
    resolvedPeriod: {
      startDate: "2026-07-30",
      endDate: "2026-07-30",
      start: "2026-07-30T04:00:00.000Z",
      end: "2026-07-31T04:00:00.000Z",
      timeZone: "America/New_York",
    },
  });
});

it("rejects Calendar ranges longer than 31 inclusive days", async () => {
  const adapter: CalendarAdapter = {
    async getDefaultTimeZone() {
      return "America/New_York";
    },
    listEvents: vi.fn(async () => []),
  };
  const calendar = createCalendar(adapter);

  const result = await calendar.listEvents({
    period: {
      kind: "range",
      startDate: "2026-07-01",
      endDate: "2026-08-01",
    },
  });

  expect(result).toEqual({
    status: "error",
    reason: "range_too_large",
    maxRangeDays: 31,
  });
  expect(adapter.listEvents).not.toHaveBeenCalled();
});

it("orders Events across Calendar sources while preserving matching Events", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() {
      return [
        { kind: "timed" as const, title: "Standup", source: "Work",
          start: "2026-07-30T13:00:00.000Z", end: "2026-07-30T13:30:00.000Z" },
        { kind: "all-day" as const, title: "Birthday", source: "Personal",
          startDate: "2026-07-30", endDate: "2026-07-31" },
        { kind: "timed" as const, title: "Standup", source: "Personal",
          start: "2026-07-30T13:00:00.000Z", end: "2026-07-30T13:30:00.000Z" },
      ];
    },
  }, { now: () => new Date("2026-07-29T15:00:00.000Z") });

  const result = await calendar.listEvents({
    period: { kind: "date", date: "2026-07-30" },
  });

  expect(result).toMatchObject({ status: "ok", events: [
    { title: "Birthday", source: "Personal" },
    { title: "Standup", source: "Personal" },
    { title: "Standup", source: "Work" },
  ] });
});
