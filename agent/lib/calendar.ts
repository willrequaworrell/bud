export interface CalendarEventRange {
  end: string;
  start: string;
  timeZone: string;
}

export type CalendarEvent =
  | { kind: "all-day"; endDate: string; source: string; startDate: string; title: string }
  | { kind: "timed"; end: string; source: string; start: string; title: string };

type PreparedEventWarning =
  | { kind: "starts-in-past"; message: "Starts in the past" }
  | { conflict: CalendarEvent; kind: "overlap"; message: string };

export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type EventRecurrence = {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays?: RecurrenceWeekday[] | undefined;
  end: { kind: "count"; count: number } | { kind: "until"; date: string };
};

type PreparedEventDetails =
  | {
      conflictTimeZone: string;
      description: string | null;
      endLocal: string;
      kind: "timed";
      location: string | null;
      recurrence?: EventRecurrence | undefined;
      startLocal: string;
      timeZone: string;
      title: string;
      warnings: PreparedEventWarning[];
    }
  | {
      conflictTimeZone: string;
      description: string | null;
      kind: "all-day";
      location: string | null;
      recurrence?: EventRecurrence | undefined;
      startDate: string;
      throughDate: string;
      timeZone: string;
      title: string;
      warnings: PreparedEventWarning[];
    };

export type PreparedEvent = PreparedEventDetails & { preparedWriteId: string };

export type CalendarEventWrite = (
  | Omit<Extract<PreparedEventDetails, { kind: "timed" }>, "warnings" | "conflictTimeZone">
  | Omit<Extract<PreparedEventDetails, { kind: "all-day" }>, "warnings" | "conflictTimeZone">
) & { idempotencyKey: string };

export interface CalendarAdapter {
  createEvent?(event: CalendarEventWrite): Promise<{ eventId: string }>;
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

function daysBetween(start: LocalDate, end: LocalDate): number {
  return (Date.UTC(end.year, end.month - 1, end.day) -
    Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000;
}

const weekdayCodes: readonly RecurrenceWeekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function weekdayCode(date: LocalDate): RecurrenceWeekday {
  return weekdayCodes[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;
}

function recurrenceOccurrenceCount(
  start: LocalDate,
  recurrence: EventRecurrence,
  until: LocalDate,
  ceiling: number,
): number {
  let count = 0;
  for (let offset = 0; offset <= daysBetween(start, until); offset += 1) {
    const date = addDays(start, offset);
    let occurs = false;
    if (recurrence.frequency === "daily") {
      occurs = offset % recurrence.interval === 0;
    } else if (recurrence.frequency === "weekly") {
      const startWeekday = weekdayCodes.indexOf(weekdayCode(start));
      const week = Math.floor((offset + (startWeekday === 0 ? 6 : startWeekday - 1)) / 7);
      const weekday = weekdayCode(date);
      const selected = recurrence.weekdays?.length
        ? recurrence.weekdays
        : [weekdayCode(start)];
      occurs = week % recurrence.interval === 0 && selected.includes(weekday);
    } else {
      const monthDistance = (date.year - start.year) * 12 + date.month - start.month;
      occurs = date.day === start.day && monthDistance % recurrence.interval === 0;
    }
    if (offset === 0) occurs = true;
    if (occurs && ++count > ceiling) return count;
  }
  return count;
}

function validateRecurrence(
  recurrence: EventRecurrence | undefined,
  startValue: string,
  maxOccurrences: number,
  maxDurationDays: number,
): "invalid_recurrence" | "recurrence_too_large" | undefined {
  if (!recurrence) return undefined;
  if (!Number.isInteger(recurrence.interval) || recurrence.interval < 1) return "invalid_recurrence";
  if (recurrence.frequency !== "weekly" && recurrence.weekdays !== undefined) return "invalid_recurrence";
  if (recurrence.weekdays !== undefined &&
      (recurrence.weekdays.length === 0 || new Set(recurrence.weekdays).size !== recurrence.weekdays.length ||
       recurrence.weekdays.some((day) => !weekdayCodes.includes(day)))) return "invalid_recurrence";
  const start = parseDate(startValue.slice(0, 10));
  if (!start) return "invalid_recurrence";
  if (recurrence.end.kind === "count") {
    if (!Number.isInteger(recurrence.end.count) || recurrence.end.count < 1) return "invalid_recurrence";
    if (recurrence.end.count > maxOccurrences) return "recurrence_too_large";
    const lastAllowed = addDays(start, maxDurationDays);
    if (recurrenceOccurrenceCount(start, recurrence, lastAllowed, recurrence.end.count) <
        recurrence.end.count) return "recurrence_too_large";
    return undefined;
  }
  const until = parseDate(recurrence.end.date);
  if (!until || daysBetween(start, until) < 0) return "invalid_recurrence";
  if (daysBetween(start, until) > maxDurationDays ||
      recurrenceOccurrenceCount(start, recurrence, until, maxOccurrences) > maxOccurrences) {
    return "recurrence_too_large";
  }
  return undefined;
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

function addMinutes(value: string, minutes: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute! + minutes));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 16);
}

function localDateTimeInstant(value: string, timeZone: string): Date | "ambiguous" | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (!parseDate(`${match[1]}-${match[2]}-${match[3]}`) || hour! > 23 || minute! > 59) return undefined;
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const wallClockValue = (instant: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit", hour: "2-digit", hour12: false, minute: "2-digit",
      month: "2-digit", timeZone, year: "numeric",
    }).formatToParts(instant);
    const number = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value.replace("24", "0"));
    return Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"));
  };
  let candidate = new Date(target);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = wallClockValue(candidate);
    const difference = target - actual;
    if (difference === 0) {
      const hour = 60 * 60 * 1000;
      if (wallClockValue(new Date(candidate.getTime() - hour)) === target ||
          wallClockValue(new Date(candidate.getTime() + hour)) === target) return "ambiguous";
      return candidate;
    }
    candidate = new Date(candidate.getTime() + difference);
  }
  return undefined;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function preparedWriteIdentity(preparedEvent: PreparedEventDetails): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(preparedEvent))).digest("hex");
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

function sortEvents(events: readonly CalendarEvent[], timeZone: string): CalendarEvent[] {
  return [...events].sort((left, right) => {
    const leftDate = left.kind === "all-day"
      ? left.startDate
      : formatDate(partsAt(new Date(left.start), timeZone));
    const rightDate = right.kind === "all-day"
      ? right.startDate
      : formatDate(partsAt(new Date(right.start), timeZone));
    const dateOrder = leftDate.localeCompare(rightDate);
    if (dateOrder !== 0) return dateOrder;
    if (left.kind !== right.kind) return left.kind === "all-day" ? -1 : 1;
    if (left.kind === "timed" && right.kind === "timed") {
      const timeOrder = new Date(left.start).getTime() - new Date(right.start).getTime();
      if (timeOrder !== 0) return timeOrder;
    }
    return left.source.localeCompare(right.source) || left.title.localeCompare(right.title);
  });
}

interface EventInterval {
  end: Date;
  start: Date;
}

function preparedEventInterval(preparedEvent: PreparedEventDetails): EventInterval {
  if (preparedEvent.kind === "timed") {
    return {
      start: localDateTimeInstant(preparedEvent.startLocal, preparedEvent.timeZone) as Date,
      end: localDateTimeInstant(preparedEvent.endLocal, preparedEvent.timeZone) as Date,
    };
  }
  return {
    start: zonedMidnight(parseDate(preparedEvent.startDate)!, preparedEvent.conflictTimeZone),
    end: zonedMidnight(addDays(parseDate(preparedEvent.throughDate)!, 1), preparedEvent.conflictTimeZone),
  };
}

function calendarEventInterval(event: CalendarEvent, timeZone: string): EventInterval | undefined {
  if (event.kind === "timed") {
    const start = new Date(event.start);
    const end = new Date(event.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return undefined;
    return { start, end };
  }
  const startDate = parseDate(event.startDate);
  const endDate = parseDate(event.endDate);
  if (!startDate || !endDate) return undefined;
  return { start: zonedMidnight(startDate, timeZone), end: zonedMidnight(endDate, timeZone) };
}

function conflictWarnings(
  events: readonly CalendarEvent[],
  interval: EventInterval,
  timeZone: string,
): PreparedEventWarning[] {
  return events.flatMap((event) => {
    const existing = calendarEventInterval(event, timeZone);
    if (!existing || interval.start >= existing.end || interval.end <= existing.start) return [];
    const conflict: CalendarEvent = event.kind === "timed"
      ? { ...event, start: existing.start.toISOString(), end: existing.end.toISOString() }
      : event;
    return [{
      kind: "overlap" as const,
      message: `Overlaps ${event.title} (${event.source})`,
      conflict,
    }];
  }).sort((left, right) => JSON.stringify(canonicalValue(left.conflict))
    .localeCompare(JSON.stringify(canonicalValue(right.conflict))));
}

function failureReason(error: unknown): CalendarFailure {
  return error instanceof CalendarAdapterError ? error.reason : "unavailable";
}

export function createCalendar(
  adapter: CalendarAdapter,
  options: { now?: () => Date; maxRangeDays?: number; maxRecurrenceDays?: number; maxRecurrenceOccurrences?: number } = {},
) {
  const now = options.now ?? (() => new Date());
  const maxRangeDays = options.maxRangeDays ?? 31;
  const maxRecurrenceDays = options.maxRecurrenceDays ?? 365;
  const maxRecurrenceOccurrences = options.maxRecurrenceOccurrences ?? 100;

  async function readConflictWarnings(preparedEvent: PreparedEventDetails) {
    const interval = preparedEventInterval(preparedEvent);
    const events = await adapter.listEvents({
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
      timeZone: preparedEvent.conflictTimeZone,
    });
    return conflictWarnings(events, interval, preparedEvent.conflictTimeZone);
  }

  return {
    async prepareEvent(request:
      | { kind: "timed"; title: string; startLocal: string; endLocal?: string | undefined; timeZone?: string | undefined; location?: string | undefined; description?: string | undefined; recurrence?: EventRecurrence | undefined }
      | { kind: "all-day"; title: string; startDate: string; throughDate?: string | undefined; timeZone?: string | undefined; location?: string | undefined; description?: string | undefined; recurrence?: EventRecurrence | undefined }
    ) {
      const title = request.title.trim();
      if (!title) return { status: "error" as const, reason: "title_required" as const };
      let timeZone: string;
      let writeTimeZone: string;
      try {
        writeTimeZone = await adapter.getDefaultTimeZone();
        timeZone = request.timeZone ?? writeTimeZone;
      } catch (error) {
        return { status: "error" as const, reason: error instanceof CalendarAdapterError ? error.reason : "unavailable" as const };
      }
      if (!isTimeZone(timeZone)) return { status: "error" as const, reason: "invalid_time_zone" as const };
      const common = {
        conflictTimeZone: writeTimeZone,
        description: request.description?.trim() || null,
        location: request.location?.trim() || null,
        timeZone,
        title,
        ...(request.recurrence ? { recurrence: request.recurrence } : {}),
      };
      const recurrenceFailure = validateRecurrence(
        request.recurrence,
        request.kind === "timed" ? request.startLocal : request.startDate,
        maxRecurrenceOccurrences,
        maxRecurrenceDays,
      );
      if (recurrenceFailure) {
        return { status: "error" as const, reason: recurrenceFailure,
          maxOccurrences: maxRecurrenceOccurrences, maxDurationDays: maxRecurrenceDays };
      }
      let preparedEvent: PreparedEventDetails;
      if (request.kind === "timed") {
        const endLocal = request.endLocal ?? addMinutes(request.startLocal, 30);
        if (!endLocal) return { status: "error" as const, reason: "invalid_time" as const };
        const start = localDateTimeInstant(request.startLocal, timeZone);
        const end = localDateTimeInstant(endLocal, timeZone);
        if (start === "ambiguous" || end === "ambiguous") {
          return { status: "error" as const, reason: "ambiguous_time" as const };
        }
        if (!start || !end || end <= start) return { status: "error" as const, reason: "invalid_time" as const };
        preparedEvent = { ...common, kind: "timed", startLocal: request.startLocal, endLocal,
          warnings: start < now() ? [{ kind: "starts-in-past", message: "Starts in the past" }] : [] };
      } else {
        const start = parseDate(request.startDate);
        const through = parseDate(request.throughDate ?? request.startDate);
        if (!start || !through || inclusiveDays(start, through) < 1) {
          return { status: "error" as const, reason: "invalid_date" as const };
        }
        preparedEvent = { ...common, kind: "all-day", startDate: request.startDate,
          throughDate: request.throughDate ?? request.startDate,
          warnings: zonedMidnight(start, timeZone) < now()
            ? [{ kind: "starts-in-past", message: "Starts in the past" }] : [] };
      }
      try {
        preparedEvent.warnings.push(...await readConflictWarnings(preparedEvent));
      } catch (error) {
        return { status: "error" as const, reason: failureReason(error) };
      }
      return { status: "ok" as const, preparedEvent: {
        ...preparedEvent,
        preparedWriteId: preparedWriteIdentity(preparedEvent),
      } as PreparedEvent };
    },
    async createEvent(preparedEvent: PreparedEvent, idempotencyKey: string) {
      const { preparedWriteId, warnings, conflictTimeZone, ...event } = preparedEvent;
      const exactPreparedEvent = { ...event, warnings, conflictTimeZone } as PreparedEventDetails;
      if (preparedWriteIdentity(exactPreparedEvent) !== preparedWriteId) {
        return { status: "error" as const, reason: "prepared_write_changed" as const };
      }
      if (!adapter.createEvent) {
        return { status: "error" as const, reason: "unavailable" as const };
      }
      try {
        const writeTimeZone = await adapter.getDefaultTimeZone();
        if (writeTimeZone !== conflictTimeZone) {
          return { status: "error" as const, reason: "conflicts_changed" as const };
        }
        const priorConflicts = warnings.filter((warning) => warning.kind === "overlap");
        const currentConflicts = await readConflictWarnings(exactPreparedEvent);
        if (JSON.stringify(canonicalValue(currentConflicts)) !==
            JSON.stringify(canonicalValue(priorConflicts))) {
          return { status: "error" as const, reason: "conflicts_changed" as const };
        }
        const created = await adapter.createEvent({ ...event, idempotencyKey });
        return { status: "ok" as const, eventId: created.eventId };
      } catch (error) {
        return {
          status: "error" as const,
          reason: failureReason(error),
        };
      }
    },
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
        events: sortEvents(events, timeZone),
        resolvedPeriod: {
          ...range,
          endDate: formatDate(endDate),
          startDate: formatDate(startDate),
        },
      };
    },
  };
}
import { createHash } from "node:crypto";
