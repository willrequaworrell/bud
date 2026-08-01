import type { BudConfig } from "./config.js";
import { createGoogleTokenProvider } from "./google-token-provider.js";
import {
  CalendarAdapterError,
  type CalendarAdapter,
  type CalendarEvent,
  type CalendarEventRange,
  type CalendarEventWrite,
} from "./calendar.js";
import type { TokenProvider } from "./token-provider.js";

interface GoogleCalendarOptions {
  fetch?: typeof fetch;
  readCalendarIds: readonly string[];
  tokenProvider: TokenProvider;
  writeCalendarId: string;
}

class GoogleEventConflict extends Error {}

function failureForStatus(status: number, payload?: unknown): CalendarAdapterError {
  if (status === 401) return new CalendarAdapterError("authentication_expired");
  if (status === 403) {
    const reasons = JSON.stringify(payload);
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reasons)) {
      return new CalendarAdapterError("rate_limited");
    }
    return new CalendarAdapterError("access_revoked");
  }
  if (status === 429) return new CalendarAdapterError("rate_limited");
  return new CalendarAdapterError("unavailable");
}

export function createGoogleCalendarAdapter(
  options: GoogleCalendarOptions,
): CalendarAdapter {
  const request = options.fetch ?? fetch;

  async function googleGet(path: string): Promise<unknown> {
    return googleRequest(path, {});
  }

  async function googleRequest(path: string, init: RequestInit): Promise<unknown> {
    const token = await options.tokenProvider.getAccessToken();
    let response: Response;
    try {
      response = await request(`https://www.googleapis.com/calendar/v3${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
      });
    } catch {
      throw new CalendarAdapterError("unavailable");
    }
    const payload = await response.json().catch(() => undefined);
    if (response.status === 409) throw new GoogleEventConflict();
    if (!response.ok) throw failureForStatus(response.status, payload);
    return payload;
  }

  function nextDate(value: string): string {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
  }

  function googleEventId(idempotencyKey: string): string {
    return `bud${createHash("sha256").update(idempotencyKey).digest("hex")}`;
  }

  function googleDateTime(localDateTime: string): string {
    return `${localDateTime}:00`;
  }

  function providerLocalTime(value: string | undefined, timeZone: string): string | undefined {
    if (!value) return undefined;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value;
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) return undefined;
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit", hour: "2-digit", hour12: false, minute: "2-digit",
      month: "2-digit", timeZone, year: "numeric",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value.replace("24", "00");
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  }

  function matchesEvent(existing: unknown, event: CalendarEventWrite, id: string, proposalHash: string) {
    const prior = existing as {
      id?: string; summary?: string; location?: string; description?: string;
      start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
      reminders?: { useDefault?: boolean };
      extendedProperties?: { private?: { budProposalHash?: string } };
    };
    const common = prior.id === id && prior.summary === event.title &&
      (prior.location ?? null) === event.location && (prior.description ?? null) === event.description &&
      prior.reminders?.useDefault === true &&
      prior.extendedProperties?.private?.budProposalHash === proposalHash;
    if (!common) return false;
    return event.kind === "all-day"
      ? prior.start?.date === event.startDate && prior.end?.date === nextDate(event.throughDate)
      : providerLocalTime(prior.start?.dateTime, event.timeZone) === event.startLocal &&
        providerLocalTime(prior.end?.dateTime, event.timeZone) === event.endLocal;
  }

  async function createEvent(event: CalendarEventWrite) {
    const details = {
      summary: event.title,
      ...(event.location ? { location: event.location } : {}),
      ...(event.description ? { description: event.description } : {}),
      ...(event.kind === "timed"
        ? { start: { dateTime: googleDateTime(event.startLocal), timeZone: event.timeZone }, end: { dateTime: googleDateTime(event.endLocal), timeZone: event.timeZone } }
        : { start: { date: event.startDate }, end: { date: nextDate(event.throughDate) } }),
      reminders: { useDefault: true },
    };
    const proposalHash = createHash("sha256").update(JSON.stringify(details)).digest("hex");
    const body = {
      id: googleEventId(event.idempotencyKey),
      ...details,
      extendedProperties: { private: { budProposalHash: proposalHash } },
    };
    const calendarPath = `/calendars/${encodeURIComponent(options.writeCalendarId)}`;
    let payload: { id?: string };
    try {
      payload = await googleRequest(`${calendarPath}/events`, {
        method: "POST", body: JSON.stringify(body),
      }) as { id?: string };
    } catch (error) {
      if (!(error instanceof GoogleEventConflict)) throw error;
      const existing = await googleGet(`${calendarPath}/events/${body.id}`);
      if (!matchesEvent(existing, event, body.id, proposalHash)) {
        throw new CalendarAdapterError("unavailable");
      }
      payload = existing as { id?: string };
    }
    if (!payload.id) throw new CalendarAdapterError("unavailable");
    return { eventId: payload.id };
  }

  const metadata = new Map<string, Promise<{ summary: string; timeZone?: string }>>();

  function getCalendarMetadata(calendarId: string) {
    let pending = metadata.get(calendarId);
    if (!pending) {
      pending = googleGet(`/calendars/${encodeURIComponent(calendarId)}`)
        .then((payload) => {
          const calendar = payload as { summary?: string; timeZone?: string };
          if (!calendar.summary) throw new CalendarAdapterError("unavailable");
          return {
            summary: calendar.summary,
            ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}),
          };
        })
        .catch((error) => {
          metadata.delete(calendarId);
          throw error;
        });
      metadata.set(calendarId, pending);
    }
    return pending;
  }

  async function listCalendarEvents(calendarId: string, range: CalendarEventRange) {
    const { summary: source } = await getCalendarMetadata(calendarId);
    const calendarPath = `/calendars/${encodeURIComponent(calendarId)}`;
    const query = new URLSearchParams({
      orderBy: "startTime",
      singleEvents: "true",
      timeMax: range.end,
      timeMin: range.start,
      timeZone: range.timeZone,
    });
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      if (pageToken) query.set("pageToken", pageToken);
      const payload = await googleGet(`${calendarPath}/events?${query}`) as {
        items?: Array<{
          end?: { date?: string; dateTime?: string };
          start?: { date?: string; dateTime?: string };
          status?: string;
          summary?: string;
        }>;
        nextPageToken?: string;
      };
      events.push(...(payload.items ?? []).flatMap<CalendarEvent>((item) => {
        if (item.status === "cancelled") return [];
        const title = item.summary ?? "Untitled event";
        if (item.start?.dateTime && item.end?.dateTime) {
          return [{ kind: "timed", end: item.end.dateTime, source, start: item.start.dateTime, title }];
        }
        if (item.start?.date && item.end?.date) {
          return [{ kind: "all-day", endDate: item.end.date, source, startDate: item.start.date, title }];
        }
        return [];
      }));
      pageToken = payload.nextPageToken;
    } while (pageToken);
    return events;
  }

  return {
    createEvent,
    async getDefaultTimeZone() {
      const calendar = await getCalendarMetadata(options.writeCalendarId);
      if (!calendar.timeZone) throw new CalendarAdapterError("unavailable");
      return calendar.timeZone;
    },
    async listEvents(range: CalendarEventRange) {
      return (await Promise.all(
        options.readCalendarIds.map((calendarId) => listCalendarEvents(calendarId, range)),
      )).flat();
    },
  };
}

export function createConfiguredGoogleCalendarAdapter(
  config: BudConfig,
  googleFetch?: typeof fetch,
): CalendarAdapter {
  return createGoogleCalendarAdapter({
    ...(googleFetch ? { fetch: googleFetch } : {}),
    readCalendarIds: config.googleCalendarReadIds,
    tokenProvider: createGoogleTokenProvider({
      clientId: config.googleOAuthClientId,
      clientSecret: config.googleOAuthClientSecret,
      ...(googleFetch ? { fetch: googleFetch } : {}),
      refreshToken: config.googleOAuthRefreshToken,
    }),
    writeCalendarId: config.googleCalendarId,
  });
}
import { createHash } from "node:crypto";
