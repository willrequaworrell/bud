import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { groupTasks, TasksAdapterError, type TasksAdapter } from "./tasks.js";

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone, year: "numeric",
  }).format(now);
}

export function createListIncompleteTasksTool(options: {
  adapter: TasksAdapter;
  now?: () => Date;
  ownerId: string;
  resultLimit: number;
  timeZone: string | (() => Promise<string>);
}) {
  return defineTool({
    description: "List incomplete Tasks from the Owner's configured Tasks list. Use for an unqualified request for Tasks. Results are grouped as overdue, upcoming (including today), and undated. If truncated is true, tell the Owner more Tasks exist and suggest a narrower request.",
    inputSchema: z.object({}),
    async execute(_input, ctx: ToolContext) {
      if (ctx.session.auth.current?.principalId !== `telegram:${options.ownerId}`) {
        return { status: "error" as const, reason: "forbidden" as const };
      }
      try {
        const page = await options.adapter.listIncomplete(options.resultLimit);
        const timeZone = typeof options.timeZone === "string"
          ? options.timeZone
          : await options.timeZone().catch(() => "UTC");
        return {
          status: "ok" as const,
          ...groupTasks(page.tasks, localDate((options.now ?? (() => new Date()))(), timeZone)),
          truncated: page.truncated,
        };
      } catch (error) {
        return {
          status: "error" as const,
          reason: error instanceof TasksAdapterError ? error.failure : "unavailable" as const,
        };
      }
    },
  });
}
