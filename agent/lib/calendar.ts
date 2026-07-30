export interface CalendarEventRange {
  end: string;
  start: string;
  timeZone: string;
}

export type CalendarEvent =
  | { kind: "all-day"; endDate: string; startDate: string; title: string }
  | { kind: "timed"; end: string; start: string; title: string };

export interface CalendarAdapter {
  getDefaultTimeZone(): Promise<string>;
  listEvents(range: CalendarEventRange): Promise<readonly CalendarEvent[]>;
}

export type CalendarFailure =
  | "access_revoked"
  | "authentication_expired"
  | "rate_limited"
  | "unavailable";

export class CalendarAdapterError extends Error {
  constructor(readonly reason: CalendarFailure) {
    super(reason);
    this.name = "CalendarAdapterError";
  }
}

export type CalendarPeriod =
  | { kind: "remainder-of-today" }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "date"; date: string }
  | { kind: "range"; endDate: string; startDate: string };

interface LocalDate {
  day: number;
  month: number;
  year: number;
}

function partsAt(instant: Date, timeZone: string): LocalDate {
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

function addDays(date: LocalDate, days: number): LocalDate {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    day: result.getUTCDate(),
    month: result.getUTCMonth() + 1,
    year: result.getUTCFullYear(),
  };
}

function parseDate(value: string): LocalDate | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = { year: year!, month: month!, day: day! };
  const normalized = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (
    normalized.getUTCFullYear() !== parsed.year ||
    normalized.getUTCMonth() + 1 !== parsed.month ||
    normalized.getUTCDate() !== parsed.day
  ) return undefined;
  return parsed;
}

function inclusiveDays(start: LocalDate, end: LocalDate): number {
  return (
    Date.UTC(end.year, end.month - 1, end.day) -
    Date.UTC(start.year, start.month - 1, start.day)
  ) / 86_400_000 + 1;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function formatDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
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
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone,
  }).formatToParts(candidate);
  const hour = Number(
    timeParts.find((part) => part.type === "hour")?.value.replace("24", "0"),
  );
  const minute = Number(timeParts.find((part) => part.type === "minute")?.value);
  return new Date(candidate.getTime() - (hour * 60 + minute) * 60 * 1000);
}

export function createCalendar(
  adapter: CalendarAdapter,
  options: { now?: () => Date; maxRangeDays?: number } = {},
) {
  const now = options.now ?? (() => new Date());
  const maxRangeDays = options.maxRangeDays ?? 31;

  return {
    async listEvents(request: { period: CalendarPeriod; timeZone?: string }) {
      let timeZone: string;
      try {
        timeZone = request.timeZone ?? await adapter.getDefaultTimeZone();
      } catch (error) {
        return {
          status: "error" as const,
          reason: error instanceof CalendarAdapterError ? error.reason : "unavailable" as const,
        };
      }
      if (!isTimeZone(timeZone)) {
        return { status: "error" as const, reason: "invalid_time_zone" as const };
      }
      const currentInstant = now();
      const currentDate = partsAt(currentInstant, timeZone);
      let startDate: LocalDate | undefined;
      let endDate: LocalDate | undefined;
      switch (request.period.kind) {
        case "remainder-of-today":
        case "today":
          startDate = currentDate;
          endDate = currentDate;
          break;
        case "tomorrow":
          startDate = addDays(currentDate, 1);
          endDate = startDate;
          break;
        case "date":
          startDate = parseDate(request.period.date);
          endDate = startDate;
          break;
        case "range":
          startDate = parseDate(request.period.startDate);
          endDate = parseDate(request.period.endDate);
          break;
      }
      if (!startDate || !endDate) {
        return { status: "error" as const, reason: "invalid_period" as const };
      }
      const dayCount = inclusiveDays(startDate, endDate);
      if (dayCount < 1) {
        return { status: "error" as const, reason: "invalid_period" as const };
      }
      if (dayCount > maxRangeDays) {
        return {
          status: "error" as const,
          reason: "range_too_large" as const,
          maxRangeDays,
        };
      }
      const start = request.period.kind === "remainder-of-today"
        ? currentInstant
        : zonedMidnight(startDate, timeZone);
      const end = zonedMidnight(addDays(endDate, 1), timeZone);
      const range = {
        end: end.toISOString(),
        start: start.toISOString(),
        timeZone,
      };
      let events: readonly CalendarEvent[];
      try {
        events = await adapter.listEvents(range);
      } catch (error) {
        return {
          status: "error" as const,
          reason: error instanceof CalendarAdapterError ? error.reason : "unavailable" as const,
          resolvedPeriod: {
            ...range,
            endDate: formatDate(endDate),
            startDate: formatDate(startDate),
          },
        };
      }
      return {
        status: "ok" as const,
        events,
        resolvedPeriod: {
          ...range,
          endDate: formatDate(endDate),
          startDate: formatDate(startDate),
        },
      };
    },
  };
}
