import { defineTool, type ToolContext } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { createCalendar, type CalendarAdapter } from "./calendar.js";

const periodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remainder-of-today") }),
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("date"), date: z.iso.date() }),
  z.object({ kind: z.literal("range"), startDate: z.iso.date(), endDate: z.iso.date() }),
]);

const optionalText = z.string().trim().min(1).optional();
const calendarEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timed"), title: z.string(), source: z.string(),
    start: z.string(), end: z.string() }),
  z.object({ kind: z.literal("all-day"), title: z.string(), source: z.string(),
    startDate: z.iso.date(), endDate: z.iso.date() }),
]);
const proposalWarningSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starts-in-past"), message: z.literal("Starts in the past") }),
  z.object({ kind: z.literal("overlap"), message: z.string(), conflict: calendarEventSchema }),
]);
const localDateTime = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .describe("Exact local wall-clock date and time in YYYY-MM-DDTHH:mm 24-hour format, with no seconds or UTC offset; resolve natural language before calling");
const recurrenceEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), count: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("until"), date: z.iso.date() }).strict(),
]);
const recurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().positive(),
  weekdays: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).min(1).optional(),
  end: recurrenceEndSchema,
}).strict().superRefine((value, ctx) => {
  if (value.frequency !== "weekly" && value.weekdays !== undefined) {
    ctx.addIssue({ code: "custom", message: "weekday selection is supported only for weekly recurrence" });
  }
});
const prepareEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timed"), title: z.string(), startLocal: localDateTime,
    endLocal: localDateTime.optional(),
    timeZone: z.string().optional().describe("IANA timezone such as America/New_York; omit to use the Write Calendar timezone"),
    location: optionalText, description: optionalText, recurrence: recurrenceSchema.optional(),
  }),
  z.object({
    kind: z.literal("all-day"), title: z.string(), startDate: z.iso.date(),
    throughDate: z.iso.date().optional(),
    timeZone: z.string().optional().describe("IANA timezone; omit to use the Write Calendar timezone"),
    location: optionalText, description: optionalText, recurrence: recurrenceSchema.optional(),
  }),
]);

const proposalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timed"), proposalId: z.string().length(64), title: z.string(),
    startLocal: z.string(), endLocal: z.string(), timeZone: z.string(),
    conflictTimeZone: z.string(),
    location: z.string().nullable(), description: z.string().nullable(),
    warnings: z.array(proposalWarningSchema), recurrence: recurrenceSchema.optional(),
  }),
  z.object({
    kind: z.literal("all-day"), proposalId: z.string().length(64), title: z.string(),
    startDate: z.iso.date(), throughDate: z.iso.date(), timeZone: z.string(),
    conflictTimeZone: z.string(),
    location: z.string().nullable(), description: z.string().nullable(),
    warnings: z.array(proposalWarningSchema), recurrence: recurrenceSchema.optional(),
  }),
]);

function isOwner(ctx: ToolContext, ownerId: string) {
  return ctx.session.auth.current?.principalId === `telegram:${ownerId}`;
}

export function createPrepareCalendarEventTool(options: {
  adapter: CalendarAdapter; now?: () => Date; ownerId: string;
}) {
  const calendar = createCalendar(options.adapter, options.now ? { now: options.now } : {});
  return defineTool({
    description: "Prepare one complete, immutable Calendar Event proposal, including warnings for named Events that overlap it. Recurrence supports only daily, weekly, or monthly frequency with a positive interval; weekly rules may select weekdays. Every recurrence must have an end date or occurrence count and is limited to one year and 100 occurrences. If a recurrence exceeds either limit, ask the Owner for a shorter end date or smaller occurrence count. Reject specialized rules and exceptions instead of approximating them. Accept natural language from the Owner, but normalize resolved timed values to YYYY-MM-DDTHH:mm 24-hour local wall-clock fields before calling. Ask one focused clarification only when title, date, time, all-day intent, timezone, or recurrence boundary is materially ambiguous. Never ask the Owner to format tool input. This tool never writes.",
    inputSchema: prepareEventSchema,
    async execute(input, ctx: ToolContext) {
      if (!isOwner(ctx, options.ownerId)) return { status: "error" as const, reason: "forbidden" as const };
      return calendar.prepareEvent(input);
    },
  });
}

export function createCreateCalendarEventTool(options: {
  adapter: CalendarAdapter; now?: () => Date; ownerId: string;
}) {
  const calendar = createCalendar(options.adapter, options.now ? { now: options.now } : {});
  return defineTool({
    description: "Revalidate Calendar conflicts, then create exactly the previously prepared one-off or bounded recurring Calendar Event on the configured Write Calendar. If conflicts changed, prepare a fresh Proposal and request approval again. Pass the complete Proposal verbatim and never alter its fields. Every call requires Owner approval.",
    inputSchema: z.object({ proposal: proposalSchema }),
    approval: always(),
    async execute(input, ctx: ToolContext) {
      if (!isOwner(ctx, options.ownerId)) return { status: "error" as const, reason: "forbidden" as const };
      return calendar.createEvent(input.proposal, ctx.callId);
    },
  });
}

export function createListCalendarEventsTool(options: {
  adapter: CalendarAdapter;
  now?: () => Date;
  ownerId: string;
}) {
  const calendar = createCalendar(options.adapter, options.now ? { now: options.now } : {});
  return defineTool({
    description: "List Events from the Owner's configured Calendar for an exact semantic date period. When the request refers to today and asks what is left, remaining, still ahead, or on the Calendar for the rest of the day, use remainder-of-today; it starts at the current instant and includes currently active Events. Do not apply this rule to a different explicit date or period. Use today for the whole local Calendar day when the Owner asks for everything today, including past Events. Resolve other natural-language dates to this structure; ask the Owner when a material date is ambiguous.",
    inputSchema: z.object({
      period: periodSchema,
      timeZone: z.string().optional().describe("IANA timezone; omit to use the Calendar timezone"),
    }),
    async execute(input, ctx: ToolContext) {
      if (!isOwner(ctx, options.ownerId)) {
        return { status: "error" as const, reason: "forbidden" as const };
      }
      return calendar.listEvents({
        period: input.period,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
    },
  });
}
