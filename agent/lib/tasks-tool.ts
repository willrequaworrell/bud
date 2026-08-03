import { defineTool, type ToolContext } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  createTasks, groupTasks, isTaskProposalUnchanged, TasksAdapterError, type TasksAdapter,
} from "./tasks.js";

const taskDetailsSchema = z.object({
  title: z.string(),
  notes: z.string().trim().min(1).optional(),
  dueDate: z.iso.date().optional(),
});

const taskProposalSchema = z.object({
  title: z.string(), notes: z.string().nullable(), dueDate: z.iso.date().nullable(),
  proposalId: z.string().length(64),
}).refine(isTaskProposalUnchanged, { message: "Task Proposal fields changed after preparation" });

function isOwner(ctx: ToolContext, ownerId: string) {
  return ctx.session.auth.current?.principalId === `telegram:${ownerId}`;
}

export function createPrepareTaskTool(options: { adapter: TasksAdapter; ownerId: string }) {
  const tasks = createTasks(options.adapter);
  return defineTool({
    description: "Prepare one complete immutable Task Proposal. The title is required. Include notes only when the Owner explicitly supplies meaningful notes; punctuation around the title is not notes. Include a date-only due date only when the Owner explicitly requests one; otherwise omit dueDate so the Task remains undated. Never infer tomorrow or any other due date. If the Owner specifies a time, do not call this tool: explain that Google Tasks cannot retain a time and offer a Calendar Event Proposal instead. This tool never writes.",
    inputSchema: taskDetailsSchema,
    async execute(input, ctx: ToolContext) {
      if (!isOwner(ctx, options.ownerId)) return { status: "error" as const, reason: "forbidden" as const };
      return tasks.prepareTask(input);
    },
  });
}

export function createCreateTaskTool(options: { adapter: TasksAdapter; ownerId: string }) {
  const tasks = createTasks(options.adapter);
  return defineTool({
    description: "Create exactly one previously prepared Task. Pass the complete Proposal returned by prepare_task through verbatim; never reconstruct, summarize, fill defaults, or alter any field. Every call requires Owner approval.",
    inputSchema: z.object({ proposal: taskProposalSchema }),
    approval: always(),
    async execute(input, ctx: ToolContext) {
      if (!isOwner(ctx, options.ownerId)) return { status: "error" as const, reason: "forbidden" as const };
      return tasks.createTask(input.proposal, ctx.callId);
    },
  });
}

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
      if (!isOwner(ctx, options.ownerId)) {
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
