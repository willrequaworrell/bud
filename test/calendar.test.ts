import { expect, it, vi } from "vitest";

import {
  CalendarAdapterError,
  createCalendar,
  type CalendarAdapter,
  type EventRecurrence,
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
      conflictTimeZone: "America/New_York",
      location: null,
      description: null,
      warnings: [],
    },
  });
  expect(createEvent).not.toHaveBeenCalled();
});

it.each([
  [{ frequency: "daily", interval: 1, end: { kind: "count", count: 5 } },
    { frequency: "daily", interval: 1, end: { kind: "count", count: 5 } }],
  [{ frequency: "weekly", interval: 2, weekdays: ["MO", "TH"], end: { kind: "until", date: "2026-10-01" } },
    { frequency: "weekly", interval: 2, weekdays: ["MO", "TH"], end: { kind: "until", date: "2026-10-01" } }],
  [{ frequency: "monthly", interval: 1, end: { kind: "count", count: 4 } },
    { frequency: "monthly", interval: 1, end: { kind: "count", count: 4 } }],
] as const)("prepares a bounded recurring Event Proposal", async (recurrence, expected) => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { return []; },
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });

  expect(await calendar.prepareEvent({
    kind: "timed", title: "Practice", startLocal: "2026-08-03T09:00",
    recurrence: recurrence as unknown as EventRecurrence,
  })).toMatchObject({ status: "ok", proposal: { recurrence: expected } });
});

it.each([
  [{ frequency: "daily", interval: 1, end: { kind: "count", count: 101 } }, "recurrence_too_large"],
  [{ frequency: "weekly", interval: 1, end: { kind: "count", count: 100 } }, "recurrence_too_large"],
  [{ frequency: "daily", interval: 1, end: { kind: "until", date: "2027-08-04" } }, "recurrence_too_large"],
  [{ frequency: "weekly", interval: 0, weekdays: ["MO"], end: { kind: "count", count: 2 } }, "invalid_recurrence"],
  [{ frequency: "monthly", interval: 1, weekdays: ["MO"], end: { kind: "count", count: 2 } }, "invalid_recurrence"],
] as const)("rejects an invalid or over-limit recurrence", async (recurrence, reason) => {
  const listEvents = vi.fn(async () => []);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "UTC"; }, listEvents,
  });

  expect(await calendar.prepareEvent({
    kind: "all-day", title: "Practice", startDate: "2026-08-03", recurrence,
  } as never)).toEqual(expect.objectContaining({ status: "error", reason }));
  expect(listEvents).not.toHaveBeenCalled();
});

it("creates exactly the approved recurrence with the retry key", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "series-1" }));
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "UTC"; }, async listEvents() { return []; }, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "all-day", title: "Practice", startDate: "2026-08-03",
    recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO", "TH"],
      end: { kind: "count", count: 8 } },
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  await calendar.createEvent(prepared.proposal, "same-call");
  expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
    recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO", "TH"],
      end: { kind: "count", count: 8 } },
    idempotencyKey: "same-call",
  }));
  await expect(calendar.createEvent({
    ...prepared.proposal,
    recurrence: { frequency: "weekly", interval: 1, weekdays: ["MO"],
      end: { kind: "count", count: 8 } },
  }, "same-call")).resolves.toEqual({ status: "error", reason: "proposal_changed" });
});

it("anchors interval weeks to Monday like the emitted Google recurrence rule", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "UTC"; }, async listEvents() { return []; },
  }, { maxRecurrenceDays: 7 });

  expect(await calendar.prepareEvent({
    kind: "all-day", title: "Practice", startDate: "2026-08-05",
    recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO"],
      end: { kind: "count", count: 2 } },
  })).toEqual(expect.objectContaining({ status: "error", reason: "recurrence_too_large" }));
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
    warnings: proposal.warnings,
    title: proposal.title,
    kind: proposal.kind,
    timeZone: proposal.timeZone,
    conflictTimeZone: proposal.conflictTimeZone,
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
  })).toMatchObject({ status: "ok", proposal: { warnings: [
    { kind: "starts-in-past", message: "Starts in the past" },
  ] } });
});

it("prepares a conflict-free Event after checking its exact interval", async () => {
  const listEvents = vi.fn(async () => []);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    listEvents,
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });

  const result = await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
    endLocal: "2026-08-03T09:30",
  });

  expect(listEvents).toHaveBeenCalledWith({
    start: "2026-08-03T13:00:00.000Z",
    end: "2026-08-03T13:30:00.000Z",
    timeZone: "America/New_York",
  });
  expect(result).toMatchObject({ status: "ok", proposal: { warnings: [] } });
});

it("warns about named timed Events that overlap the proposed interval", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() {
      return [{ kind: "timed" as const, title: "Team sync", source: "Work",
        start: "2026-08-03T13:15:00.000Z", end: "2026-08-03T14:00:00.000Z" }];
    },
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });

  expect(await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
    endLocal: "2026-08-03T09:30",
  })).toMatchObject({
    status: "ok",
    proposal: { warnings: [{
      kind: "overlap", message: "Overlaps Team sync (Work)",
      conflict: { kind: "timed", title: "Team sync", source: "Work",
        start: "2026-08-03T13:15:00.000Z", end: "2026-08-03T14:00:00.000Z" },
    }] },
  });
});

it("warns about all-day Events overlapping a timed proposal in the Write Calendar timezone", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() {
      return [{ kind: "all-day" as const, title: "Vacation", source: "Personal",
        startDate: "2026-08-03", endDate: "2026-08-04" }];
    },
  }, { now: () => new Date("2026-07-31T15:00:00.000Z") });

  expect(await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  })).toMatchObject({
    status: "ok",
    proposal: { warnings: [{
      kind: "overlap", message: "Overlaps Vacation (Personal)",
      conflict: { kind: "all-day", title: "Vacation", source: "Personal",
        startDate: "2026-08-03", endDate: "2026-08-04" },
    }] },
  });
});

it("does not present a Proposal when the conflict check fails", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() { throw new CalendarAdapterError("rate_limited"); },
  });

  expect(await calendar.prepareEvent({
    kind: "all-day", title: "Vacation", startDate: "2026-08-03",
  })).toEqual({ status: "error", reason: "rate_limited" });
});

it("warns when an all-day proposal overlaps an Event on any included day", async () => {
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; },
    async listEvents() {
      return [{ kind: "timed" as const, title: "Dinner", source: "Family",
        start: "2026-08-04T22:00:00.000Z", end: "2026-08-04T23:00:00.000Z" }];
    },
  });

  expect(await calendar.prepareEvent({
    kind: "all-day", title: "Staycation", startDate: "2026-08-03",
    throughDate: "2026-08-04",
  })).toMatchObject({
    status: "ok",
    proposal: { warnings: [{
      kind: "overlap", message: "Overlaps Dinner (Family)",
      conflict: { kind: "timed", title: "Dinner", source: "Family",
        start: "2026-08-04T22:00:00.000Z", end: "2026-08-04T23:00:00.000Z" },
    }] },
  });
});

it("uses the Write Calendar timezone for all-day conflict boundaries", async () => {
  const listEvents = vi.fn(async () => []);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; }, listEvents,
  });

  await calendar.prepareEvent({
    kind: "all-day", title: "Tokyo holiday", startDate: "2026-08-03",
    timeZone: "Asia/Tokyo",
  });

  expect(listEvents).toHaveBeenCalledWith({
    start: "2026-08-03T04:00:00.000Z",
    end: "2026-08-04T04:00:00.000Z",
    timeZone: "America/New_York",
  });
});

it("invalidates approval when a new conflict appears before creation", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const listEvents = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ kind: "timed" as const, title: "Team sync", source: "Work",
      start: "2026-08-03T13:15:00.000Z", end: "2026-08-03T14:00:00.000Z" }]);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; }, listEvents, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "error", reason: "conflicts_changed",
  });
  expect(listEvents).toHaveBeenCalledTimes(2);
  expect(createEvent).not.toHaveBeenCalled();
});

it("invalidates approval when a conflict is removed before creation", async () => {
  const conflict = { kind: "all-day" as const, title: "Vacation", source: "Personal",
    startDate: "2026-08-03", endDate: "2026-08-04" };
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const listEvents = vi.fn().mockResolvedValueOnce([conflict]).mockResolvedValueOnce([]);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; }, listEvents, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "error", reason: "conflicts_changed",
  });
  expect(createEvent).not.toHaveBeenCalled();
});

it("invalidates approval when a same-named conflict changes time", async () => {
  const original = { kind: "timed" as const, title: "Team sync", source: "Work",
    start: "2026-08-03T13:00:00.000Z", end: "2026-08-03T13:20:00.000Z" };
  const moved = { ...original, start: "2026-08-03T13:10:00.000Z",
    end: "2026-08-03T13:30:00.000Z" };
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const listEvents = vi.fn().mockResolvedValueOnce([original]).mockResolvedValueOnce([moved]);
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; }, listEvents, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "error", reason: "conflicts_changed",
  });
  expect(createEvent).not.toHaveBeenCalled();
});

it("fails closed when conflict revalidation cannot read the Calendar", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const listEvents = vi.fn().mockResolvedValueOnce([])
    .mockRejectedValueOnce(new CalendarAdapterError("unavailable"));
  const calendar = createCalendar({
    async getDefaultTimeZone() { return "America/New_York"; }, listEvents, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "error", reason: "unavailable",
  });
  expect(createEvent).not.toHaveBeenCalled();
});

it("invalidates approval when the Write Calendar timezone changes", async () => {
  const createEvent = vi.fn(async () => ({ eventId: "event-1" }));
  const getDefaultTimeZone = vi.fn()
    .mockResolvedValueOnce("America/New_York")
    .mockResolvedValueOnce("America/Chicago");
  const calendar = createCalendar({
    getDefaultTimeZone, async listEvents() { return []; }, createEvent,
  });
  const prepared = await calendar.prepareEvent({
    kind: "all-day", title: "Vacation", startDate: "2026-08-03",
  });
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await calendar.createEvent(prepared.proposal, "call-123")).toEqual({
    status: "error", reason: "conflicts_changed",
  });
  expect(createEvent).not.toHaveBeenCalled();
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
