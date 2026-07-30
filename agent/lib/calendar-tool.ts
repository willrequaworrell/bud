import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { createCalendar, type CalendarAdapter } from "./calendar.js";

const periodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remainder-of-today") }),
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("date"), date: z.iso.date() }),
  z.object({ kind: z.literal("range"), startDate: z.iso.date(), endDate: z.iso.date() }),
]);

export function createListCalendarEventsTool(options: {
  adapter: CalendarAdapter;
  now?: () => Date;
  ownerId: string;
}) {
  const calendar = createCalendar(options.adapter, options.now ? { now: options.now } : {});
  return defineTool({
    description: "List events from the owner's configured calendar for an exact semantic date period. Resolve natural-language dates to this structure; ask the user when a material date is ambiguous.",
    inputSchema: z.object({
      period: periodSchema,
      timeZone: z.string().optional().describe("IANA timezone; omit to use the Calendar timezone"),
    }),
    async execute(input, ctx: ToolContext) {
      if (ctx.session.auth.current?.principalId !== `telegram:${options.ownerId}`) {
        return { status: "error" as const, reason: "forbidden" as const };
      }
      return calendar.listEvents({
        period: input.period,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      });
    },
  });
}
