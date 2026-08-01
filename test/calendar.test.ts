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

it("prepares a complete 30-minute timed Event Proposal without writing", async () => {
  const createEvent = vi.fn();
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; },
    createEvent,
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });

  const result = await calendar.prepareEvent({
    kind: "timed",
    title: "Dentist",
    startLocal: "2026-08-03T09:00",
  });

  expect(result).toEqual({
    status: "ok",
    proposal: {
      kind: "timed",
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
      title: "Dentist",
      startLocal: "2026-08-03T09:00",
      endLocal: "2026-08-03T09:30",
      timeZone: "America/New_York",
      location: null,
      description: null,
      warning: null,
    },
  });
  expect(createEvent).not.toHaveBeenCalled();
});

it("creates exactly an unchanged multi-day Event Proposal with a retry key", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "google-event" }));
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; }, createEvent,
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });
  const prepared = await calendar.prepareEvent({
    kind: "all-day", title: "Beach trip", startDate: "2026-08-07",
    throughDate: "2026-08-09", location: "Cape May",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "ok", eventId: "google-event",
  });
  expect(createEvent).toHaveBeenCalledWith({
    kind: "all-day", title: "Beach trip", startDate: "2026-08-07",
    throughDate: "2026-08-09", timeZone: "America/New_York",
    location: "Cape May", description: null, idempotencyKey: "call-123",
  });

  const proposal = prepared.proposal;
  if (proposal.kind !== "all-day") throw new Error("expected all-day proposal");
  expect(await calendar.createEvent({
    proposalId: proposal.proposalId,
    warning: proposal.warning,
    title: proposal.title,
    kind: proposal.kind,
    timeZone: proposal.timeZone,
    throughDate: proposal.throughDate,
    startDate: proposal.startDate,
    description: proposal.description,
    location: proposal.location,
  }, "call-456")).toEqual({ status: "ok", eventId: "google-event" });

  await expect(calendar.createEvent(
    { ...prepared.proposal, title: "Changed after approval" }, "call-123",
  )).resolves.toEqual({ status: "error", reason: "proposal_changed" });
});

it("warns before preparing an Event whose start is in the past", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; },
  }, { now: () => new Date("2026-08-10T15:00:00.000Z") });

  expect(await calendar.prepareEvent({
    kind: "all-day", title: "Backfill", startDate: "2026-08-09",
  })).toMatchObject({ status: "ok", proposal: { warning: "Starts in the past" } });
});

it("rejects a timed Event in a nonexistent DST wall-clock time", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; },
  });

  expect(await calendar.prepareEvent({
    kind: "timed", title: "Impossible", startLocal: "2026-03-08T02:30",
  })).toEqual({ status: "error", reason: "invalid_time" });
});

it("rejects an ambiguous fall-back wall-clock time for clarification", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; },
  });

  expect(await calendar.prepareEvent({
    kind: "timed", title: "Ambiguous", startLocal: "2026-11-01T01:30",
  })).toEqual({ status: "error", reason: "ambiguous_time" });
});
