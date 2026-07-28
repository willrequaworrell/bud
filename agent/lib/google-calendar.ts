import type { BudConfig } from "./config.js";
import { createGoogleTokenProvider } from "./google-token-provider.js";
import {
  PersonalOrganizerError,
  type Event,
  type EventRange,
  type PersonalOrganizer,
} from "./personal-organizer.js";
import type { TokenProvider } from "./token-provider.js";

interface GooglePersonalOrganizerOptions {
  calendarId: string;
  fetch?: typeof fetch;
  tokenProvider: TokenProvider;
}

function failureForStatus(status: number, payload?: unknown): PersonalOrganizerError {
  if (status === 401) return new PersonalOrganizerError("authentication-expired");
  if (status === 403) {
    const reasons = JSON.stringify(payload);
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reasons)) {
      return new PersonalOrganizerError("rate-limited");
    }
    return new PersonalOrganizerError("access-revoked");
  }
  if (status === 429) return new PersonalOrganizerError("rate-limited");
  return new PersonalOrganizerError("unavailable");
}

export function createGooglePersonalOrganizer(
  options: GooglePersonalOrganizerOptions,
): PersonalOrganizer {
  const request = options.fetch ?? fetch;

  async function googleGet(path: string): Promise<unknown> {
    const token = await options.tokenProvider.getAccessToken();
    let response: Response;
    try {
      response = await request(`https://www.googleapis.com/calendar/v3${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new PersonalOrganizerError("unavailable");
    }
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw failureForStatus(response.status, payload);
    return payload;
  }

  const calendarPath = `/calendars/${encodeURIComponent(options.calendarId)}`;
  return {
    async getDefaultTimeZone() {
      const payload = await googleGet(calendarPath) as { timeZone?: string };
      if (!payload.timeZone) throw new PersonalOrganizerError("unavailable");
      return payload.timeZone;
    },
    async listEvents(range: EventRange) {
      const query = new URLSearchParams({
        orderBy: "startTime",
        singleEvents: "true",
        timeMax: range.end,
        timeMin: range.start,
        timeZone: range.timeZone,
      });
      const events: Event[] = [];
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
        events.push(...(payload.items ?? []).flatMap<Event>((item) => {
          const start = item.start?.dateTime ?? item.start?.date;
          const end = item.end?.dateTime ?? item.end?.date;
          if (item.status === "cancelled" || !start || !end) return [];
          return [{ end, start, title: item.summary ?? "Untitled event" }];
        }));
        pageToken = payload.nextPageToken;
      } while (pageToken);
      return events;
    },
  };
}

export function createConfiguredGoogleOrganizer(
  config: BudConfig,
  googleFetch?: typeof fetch,
): PersonalOrganizer {
  return createGooglePersonalOrganizer({
    calendarId: config.googleCalendarId,
    ...(googleFetch ? { fetch: googleFetch } : {}),
    tokenProvider: createGoogleTokenProvider({
      clientId: config.googleOAuthClientId,
      clientSecret: config.googleOAuthClientSecret,
      ...(googleFetch ? { fetch: googleFetch } : {}),
      refreshToken: config.googleOAuthRefreshToken,
    }),
  });
}
