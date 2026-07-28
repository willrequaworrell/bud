import type { PersonalOrganizer } from "./personal-organizer.js";

export interface AgendaRequest {
  text: string;
}

function isCalendarRequest(text: string): boolean {
  return /\b(calendar|agenda|schedule)\b/i.test(text) &&
    /\b(what|show|tell|calendar|agenda)\b/i.test(text);
}

function partsAt(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { day: value("day"), month: value("month"), year: value("year") };
}

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    day: result.getUTCDate(),
    month: result.getUTCMonth() + 1,
    year: result.getUTCFullYear(),
  };
}

function zonedMidnight(target: LocalDate, timeZone: string): Date {
  let candidate = new Date(Date.UTC(target.year, target.month - 1, target.day));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = partsAt(candidate, timeZone);
    const difference =
      Date.UTC(target.year, target.month - 1, target.day) -
      Date.UTC(actual.year, actual.month - 1, actual.day);
    if (difference === 0) break;
    candidate = new Date(candidate.getTime() + difference);
  }
  const timeParts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", hour12: false, minute: "2-digit", timeZone,
  }).formatToParts(candidate);
  const hour = Number(timeParts.find((part) => part.type === "hour")?.value.replace("24", "0"));
  const minute = Number(timeParts.find((part) => part.type === "minute")?.value);
  return new Date(candidate.getTime() - (hour * 60 + minute) * 60 * 1000);
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function explicitDates(text: string, current: LocalDate): LocalDate[] {
  if (/\btoday\b/i.test(text) && /\btomorrow\b/i.test(text)) {
    return [current, addDays(current, 1)];
  }
  if (/\btomorrow\b/i.test(text)) return [addDays(current, 1)];
  if (/\btoday\b/i.test(text)) return [current];
  const iso = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)];
  if (iso.length > 0) {
    return iso.map((match) => ({
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    }));
  }
  const named = [...text.matchAll(
    new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, "gi"),
  )];
  const dates: LocalDate[] = [];
  for (const match of named) {
    const date = {
      day: Number(match[2]),
      month: MONTHS.indexOf(match[1]!.toLowerCase()) + 1,
      year: match[3] ? Number(match[3]) : (dates.at(-1)?.year ?? current.year),
    };
    const previous = dates.at(-1);
    if (!match[3] && previous &&
      (date.month < previous.month ||
        (date.month === previous.month && date.day < previous.day))) {
      date.year = previous.year + 1;
    }
    dates.push(date);
  }
  return dates;
}

function explicitTimeZone(text: string): string | undefined {
  const candidate = text.match(/\b[A-Z][A-Za-z_+-]+(?:\/[A-Za-z_+-]+)+\b/)?.[0];
  if (!candidate) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return undefined;
  }
}

function formatEvent(
  event: { end: string; start: string; title: string },
  timeZone: string,
): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(event.start)) {
    return `All day — ${event.title}`;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  return `${formatter.format(new Date(event.start))}–${formatter.format(new Date(event.end))} — ${event.title}`;
}

export async function answerAgendaRequest(
  request: AgendaRequest,
  organizer: PersonalOrganizer,
  now: Date,
): Promise<string | undefined> {
  if (!isCalendarRequest(request.text)) return undefined;
  const timeZone = explicitTimeZone(request.text) ?? await organizer.getDefaultTimeZone();
  const current = partsAt(now, timeZone);
  const requestedDates = explicitDates(request.text, current);
  const requestedStart = requestedDates[0];
  const requestedEnd = requestedDates.at(-1);
  const bounded = requestedStart !== undefined;
  const events = await organizer.listEvents({
    end: zonedMidnight(addDays(requestedEnd ?? current, 1), timeZone).toISOString(),
    start: bounded ? zonedMidnight(requestedStart, timeZone).toISOString() : now.toISOString(),
    timeZone,
  });
  if (events.length === 0) {
    return bounded
      ? "Your calendar is clear for that time."
      : "Your calendar is clear for the rest of today.";
  }
  return events.map((event) => formatEvent(event, timeZone)).join("\n");
}
