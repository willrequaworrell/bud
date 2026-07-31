import type { BudConfig } from "./config.js";
import { createGoogleTokenProvider } from "./google-token-provider.js";
import {
  CalendarAdapterError,
  type CalendarAdapter,
  type CalendarEvent,
  type CalendarEventRange,
} from "./calendar.js";
import type { TokenProvider } from "./token-provider.js";

interface GoogleCalendarOptions {
  fetch?: typeof fetch;
  readCalendarIds: readonly string[];
  tokenProvider: TokenProvider;
  writeCalendarId: string;
}

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
    const token = await options.tokenProvider.getAccessToken();
    let response: Response;
    try {
      response = await request(`https://www.googleapis.com/calendar/v3${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new CalendarAdapterError("unavailable");
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw failureForStatus(response.status, payload);
    return payload;
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
