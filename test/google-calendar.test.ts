import { expect, it, vi } from "vitest";

import { createGoogleCalendarAdapter } from "../agent/lib/google-calendar.js";

it("creates an all-day Event on only the configured Write Calendar", async () => {
  const googleFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "created-id" }));
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write@example.com", readCalendarIds: ["read@example.com"],
    fetch: googleFetch, tokenProvider: { async getAccessToken() { return "token"; } },
  });

  expect(await adapter.createEvent!({
    kind: "all-day", title: "Beach trip", startDate: "2026-08-07",
    throughDate: "2026-08-09", timeZone: "America/New_York",
    location: "Cape May", description: null, idempotencyKey: "call-123",
  })).toEqual({ eventId: "created-id" });

  const [url, init] = googleFetch.mock.calls[0]!;
  expect(String(url)).toBe("https://www.googleapis.com/calendar/v3/calendars/write%40example.com/events");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    id: expect.stringMatching(/^bud[0-9a-f]{64}$/),
    summary: "Beach trip", location: "Cape May",
    start: { date: "2026-08-07" }, end: { date: "2026-08-10" },
    reminders: { useDefault: true },
    extendedProperties: { private: { budProposalHash: expect.stringMatching(/^[a-f0-9]{64}$/) } },
  });
});

it("sends timed Events to Google as RFC3339 date-times", async () => {
  const googleFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "created-id" }));
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await adapter.createEvent!({
    kind: "timed", title: "Pick up handlebars",
    startLocal: "2026-08-01T11:30", endLocal: "2026-08-01T12:30",
    timeZone: "America/New_York", location: null, description: null,
    idempotencyKey: "handlebars",
  });

  const body = JSON.parse(String(googleFetch.mock.calls[0]![1]?.body));
  expect(body.start).toEqual({
    dateTime: "2026-08-01T11:30:00", timeZone: "America/New_York",
  });
  expect(body.end).toEqual({
    dateTime: "2026-08-01T12:30:00", timeZone: "America/New_York",
  });
});

it("sends the approved bounded recurrence as one exact Google recurrence rule", async () => {
  const googleFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "series-id" }));
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await adapter.createEvent!({
    kind: "timed", title: "Practice", startLocal: "2026-08-03T09:00",
    endLocal: "2026-08-03T09:30", timeZone: "America/New_York",
    location: null, description: null, idempotencyKey: "series-call",
    recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO", "TH"],
      end: { kind: "count", count: 8 } },
  });

  const body = JSON.parse(String(googleFetch.mock.calls[0]![1]?.body));
  expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=8"]);
});

it("sends a date-bounded monthly recurrence without approximating it", async () => {
  const googleFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "series-id" }));
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await adapter.createEvent!({
    kind: "all-day", title: "Close books", startDate: "2026-08-31", throughDate: "2026-08-31",
    timeZone: "UTC", location: null, description: null, idempotencyKey: "monthly",
    recurrence: { frequency: "monthly", interval: 1,
      end: { kind: "until", date: "2027-01-31" } },
  });

  expect(JSON.parse(String(googleFetch.mock.calls[0]![1]?.body)).recurrence)
    .toEqual(["RRULE:FREQ=MONTHLY;INTERVAL=1;UNTIL=20270131"]);
});

it("converts a timed recurrence end date to the end of that local day", async () => {
  const googleFetch = vi.fn<typeof fetch>(async () => Response.json({ id: "series-id" }));
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await adapter.createEvent!({
    kind: "timed", title: "Late practice", startLocal: "2026-08-03T23:30",
    endLocal: "2026-08-04T00:00", timeZone: "America/Los_Angeles",
    location: null, description: null, idempotencyKey: "until-local-day",
    recurrence: { frequency: "daily", interval: 1,
      end: { kind: "until", date: "2026-08-05" } },
  });

  expect(JSON.parse(String(googleFetch.mock.calls[0]![1]?.body)).recurrence)
    .toEqual(["RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20260806T065959Z"]);
});

it("treats a retried identical Google Event insert as success", async () => {
  let insertedBody: unknown;
  const googleFetch = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") {
      insertedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 });
    }
    return Response.json(insertedBody);
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.createEvent!({
    kind: "timed", title: "Dentist", startLocal: "2026-08-03T09:00",
    endLocal: "2026-08-03T09:30", timeZone: "America/New_York",
    location: null, description: null, idempotencyKey: "same-call",
    recurrence: { frequency: "daily", interval: 1, end: { kind: "count", count: 5 } },
  })).resolves.toEqual({ eventId: expect.stringMatching(/^bud/) });
  expect(googleFetch).toHaveBeenCalledTimes(2);
});

it("rejects a retry when the existing Google Event was edited", async () => {
  let insertedBody: any;
  const googleFetch = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") {
      insertedBody = JSON.parse(String(init.body));
      return new Response(null, { status: 409 });
    }
    return Response.json({ ...insertedBody, summary: "Edited elsewhere" });
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write", readCalendarIds: ["write"], fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.createEvent!({
    kind: "all-day", title: "Original", startDate: "2026-08-07",
    throughDate: "2026-08-07", timeZone: "America/New_York",
    location: null, description: null, idempotencyKey: "same-call",
  })).rejects.toMatchObject({ reason: "unavailable" });
});

it("reads and labels Events from every configured Read Calendar", async () => {
  const requests: string[] = [];
  const googleFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/calendars/write%40example.com")) {
      return Response.json({ summary: "Default", timeZone: "America/New_York" });
    }
    if (url.endsWith("/calendars/work%40example.com")) {
      return Response.json({ summary: "Work" });
    }
    if (url.endsWith("/calendars/personal%40example.com")) {
      return Response.json({ summary: "Personal" });
    }
    if (url.includes("/calendars/work%40example.com/events?")) {
      if (url.includes("pageToken=next")) {
        return Response.json({ items: [{ summary: "Planning",
          start: { dateTime: "2026-07-30T14:00:00Z" },
          end: { dateTime: "2026-07-30T14:30:00Z" } }] });
      }
      return Response.json({ nextPageToken: "next", items: [{ summary: "Standup",
        start: { dateTime: "2026-07-30T13:00:00Z" },
        end: { dateTime: "2026-07-30T13:30:00Z" } }] });
    }
    if (url.includes("/calendars/personal%40example.com/events?")) {
      return Response.json({ items: [{ summary: "Birthday",
        start: { date: "2026-07-30" }, end: { date: "2026-07-31" } }] });
    }
    return new Response("not found", { status: 404 });
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "write@example.com",
    readCalendarIds: ["work@example.com", "personal@example.com"],
    fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  expect(await adapter.getDefaultTimeZone()).toBe("America/New_York");
  expect(await adapter.listEvents({
    start: "2026-07-30T04:00:00.000Z",
    end: "2026-07-31T04:00:00.000Z",
    timeZone: "America/New_York",
  })).toEqual([
    { kind: "timed", title: "Standup", source: "Work",
      start: "2026-07-30T13:00:00Z", end: "2026-07-30T13:30:00Z" },
    { kind: "timed", title: "Planning", source: "Work",
      start: "2026-07-30T14:00:00Z", end: "2026-07-30T14:30:00Z" },
    { kind: "all-day", title: "Birthday", source: "Personal",
      startDate: "2026-07-30", endDate: "2026-07-31" },
  ]);
  expect(requests).toEqual(expect.arrayContaining([
    "https://www.googleapis.com/calendar/v3/calendars/write%40example.com",
    "https://www.googleapis.com/calendar/v3/calendars/work%40example.com",
    "https://www.googleapis.com/calendar/v3/calendars/personal%40example.com",
  ]));
  expect(requests.some((url) => url.includes("pageToken=next"))).toBe(true);

  await adapter.listEvents({
    start: "2026-07-30T04:00:00.000Z",
    end: "2026-07-31T04:00:00.000Z",
    timeZone: "America/New_York",
  });
  expect(requests.filter((url) => url.endsWith("/calendars/work%40example.com"))).toHaveLength(1);
});

it("fails the complete Read Set when any Event request is unavailable", async () => {
  const googleFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/calendars/work")) return Response.json({ summary: "Work" });
    if (url.endsWith("/calendars/private")) return Response.json({ summary: "Private" });
    if (url.includes("/calendars/work/events?")) return Response.json({ items: [] });
    if (url.includes("/calendars/private/events?")) return new Response(null, { status: 503 });
    return new Response(null, { status: 404 });
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "work",
    readCalendarIds: ["work", "private"],
    fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.listEvents({
    start: "2026-07-30T04:00:00.000Z",
    end: "2026-07-31T04:00:00.000Z",
    timeZone: "America/New_York",
  })).rejects.toMatchObject({ reason: "unavailable" });
});

it("fails the complete Read Set when any Calendar metadata is inaccessible", async () => {
  const googleFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/calendars/work")) return Response.json({ summary: "Work" });
    if (url.endsWith("/calendars/private")) return new Response(null, { status: 403 });
    if (url.includes("/calendars/work/events?")) return Response.json({ items: [] });
    return new Response(null, { status: 404 });
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "work",
    readCalendarIds: ["work", "private"],
    fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.listEvents({
    start: "2026-07-30T04:00:00.000Z",
    end: "2026-07-31T04:00:00.000Z",
    timeZone: "America/New_York",
  })).rejects.toMatchObject({ reason: "access_revoked" });
});

it("starts every Calendar read concurrently", async () => {
  const eventRequests: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const googleFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (!url.includes("/events?")) {
      return Response.json({ summary: url.includes("work") ? "Work" : "Personal" });
    }
    eventRequests.push(url);
    await barrier;
    return Response.json({ items: [] });
  });
  const adapter = createGoogleCalendarAdapter({
    writeCalendarId: "work",
    readCalendarIds: ["work", "personal"],
    fetch: googleFetch,
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  const pending = adapter.listEvents({
    start: "2026-07-30T04:00:00.000Z",
    end: "2026-07-31T04:00:00.000Z",
    timeZone: "America/New_York",
  });
  await vi.waitFor(() => expect(eventRequests).toHaveLength(2));
  release();
  await pending;
});
