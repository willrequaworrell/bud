import { expect, it, vi } from "vitest";

import { createGoogleCalendarAdapter } from "../agent/lib/google-calendar.js";

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
