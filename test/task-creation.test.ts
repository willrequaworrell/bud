import type { ToolContext } from "eve/tools";
import { mockModel } from "eve/evals";
import { generateText, stepCountIs, tool as modelTool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCreateTaskTool, createPrepareDetailedTaskTool, createPrepareTaskTool,
} from "../agent/lib/tasks-tool.js";
import type { TasksAdapter } from "../agent/lib/tasks.js";

function context(principalId = "telegram:42"): ToolContext {
  return { callId: "call-123", session: { auth: { current: { principalId } } } } as ToolContext;
}

function adapter(createTask = vi.fn(async () => ({ taskId: "task-1" }))): TasksAdapter {
  return { createTask, async listIncomplete() { return { tasks: [], truncated: false }; } };
}

it.each([
  [{ title: "Buy milk", notes: "Get oat milk", dueDate: "2026-08-03" },
    { title: "Buy milk", notes: "Get oat milk", dueDate: "2026-08-03" }],
  [{ title: "Buy milk" }, { title: "Buy milk", notes: null, dueDate: null }],
] as const)("prepares an immutable Task Proposal %#", async (input, expected) => {
  const tool = ("notes" in input && input.notes) || ("dueDate" in input && input.dueDate)
    ? createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" })
    : createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const result = await tool.execute(input, context());
  expect(result).toEqual({ status: "ok", proposal: {
    ...expected, proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
  } });
  expect(tool.approval).toBeUndefined();
});

it("structurally omits model-invented due dates and notes from the default Task tool", async () => {
  const tool = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = tool.inputSchema as unknown as {
    parse(input: unknown): { title: string; dueDate?: string; notes?: string };
  };
  const parsed = schema.parse({
    title: "Fit mouthguard", dueDate: "2026-08-03", notes: ".",
  });

  expect(await tool.execute(parsed, context())).toEqual({
    status: "ok",
    proposal: {
      title: "Fit mouthguard", dueDate: null, notes: null,
      proposalId: expect.any(String),
    },
  });
});

it.each([
  [
    "Create Submit report, due tomorrow",
    { title: "Submit report", dueDate: "2026-08-05" },
    { title: "Submit report", dueDate: "2026-08-05", notes: null },
  ],
  [
    "Create Submit report, due tomorrow, with a note that it needs manager approval",
    { title: "Submit report", dueDate: "2026-08-05", notes: "Needs manager approval" },
    { title: "Submit report", dueDate: "2026-08-05", notes: "Needs manager approval" },
  ],
] as const)("keeps explicitly requested Task details in their own fields for: %s", async (
  request, input, expected,
) => {
  const tool = createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" });
  const model = mockModel(({ lastUserMessage, toolResults, tools }) => {
    if (toolResults.length > 0) return "Prepared";
    expect(lastUserMessage).toBe(request);
    expect(tools.find(({ name }) => name === "prepare_detailed_task")?.description)
      .toContain("Omit notes unless the Owner explicitly requests a note");
    return { toolCalls: [{ name: "prepare_detailed_task", input }] };
  });
  const generated = await generateText({
    model,
    prompt: request,
    stopWhen: stepCountIs(2),
    tools: {
      prepare_detailed_task: modelTool({
        description: tool.description,
        inputSchema: z.object({
          title: z.string(), notes: z.string().optional(), dueDate: z.iso.date().optional(),
        }),
        execute: (toolInput) => tool.execute(toolInput, context()),
      }),
    },
  });
  const result = generated.toolResults[0]?.output;

  expect(result).toEqual({ status: "ok", proposal: {
    ...expected, proposalId: expect.stringMatching(/^[a-f0-9]{64}$/),
  } });
});

it("documents the notes extraction contract in the detailed Task model schema", () => {
  const tool = createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = JSON.stringify((tool.inputSchema as unknown as { toJSONSchema(): unknown }).toJSONSchema());

  expect(tool.description).toContain("Omit notes unless the Owner explicitly requests a note");
  expect(schema).toContain("due-date language");
  expect(schema).toContain("Omit this field otherwise");
  expect(schema).toContain("Relative phrases such as tomorrow belong only in this field");
});

it("changes Proposal identity when any displayed Task detail changes", async () => {
  const basic = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const detailed = createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" });
  const original = await basic.execute({ title: "Buy milk" }, context());
  const revised = await detailed.execute({ title: "Buy milk", notes: "Organic" }, context());
  expect(original.status).toBe("ok");
  expect(revised.status).toBe("ok");
  if (original.status === "ok" && revised.status === "ok") {
    expect(revised.proposal.proposalId).not.toBe(original.proposal.proposalId);
  }
});

it("rejects a reconstructed Proposal before displaying an approval", async () => {
  const tasks = adapter();
  const prepare = createPrepareDetailedTaskTool({ adapter: tasks, ownerId: "42" });
  const create = createCreateTaskTool({ adapter: tasks, ownerId: "42" });
  const prepared = await prepare.execute({ title: "Fit mouthguard" }, context());
  if (prepared.status !== "ok") throw new Error("expected proposal");
  const schema = create.inputSchema as unknown as {
    safeParse(input: unknown): { success: boolean };
  };

  expect(schema.safeParse({ proposal: {
    ...prepared.proposal, dueDate: "2026-08-03", notes: ".",
  } }).success).toBe(false);
});

it("creates exactly the approved Task only through per-call approval", async () => {
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const tasks = adapter(createTask);
  const prepare = createPrepareDetailedTaskTool({ adapter: tasks, ownerId: "42" });
  const create = createCreateTaskTool({ adapter: tasks, ownerId: "42" });
  const prepared = await prepare.execute({ title: "Buy milk", dueDate: "2026-08-03" }, context());
  if (prepared.status !== "ok") throw new Error("expected proposal");

  expect(await create.approval!({} as never)).toBe("user-approval");
  expect(createTask).not.toHaveBeenCalled();
  expect(await create.execute({ proposal: prepared.proposal }, context()))
    .toEqual({ status: "ok", taskId: "task-1" });
  expect(createTask).toHaveBeenCalledWith({
    title: "Buy milk", notes: null, dueDate: "2026-08-03", idempotencyKey: "call-123",
  });
});

it("rejects a changed or unauthorized Task Proposal without writing", async () => {
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const tasks = adapter(createTask);
  const prepare = createPrepareTaskTool({ adapter: tasks, ownerId: "42" });
  const create = createCreateTaskTool({ adapter: tasks, ownerId: "42" });
  const prepared = await prepare.execute({ title: "Buy milk" }, context());
  if (prepared.status !== "ok") throw new Error("expected proposal");

  await expect(create.execute({ proposal: { ...prepared.proposal, title: "Changed" } }, context()))
    .resolves.toEqual({ status: "error", reason: "proposal_changed" });
  await expect(create.execute({ proposal: prepared.proposal }, context("telegram:99")))
    .resolves.toEqual({ status: "error", reason: "forbidden" });
  expect(createTask).not.toHaveBeenCalled();
});

it.each(["", "   "])("requires a non-empty Task title", async (title) => {
  const tool = createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" });
  await expect(tool.execute({ title }, context()))
    .resolves.toEqual({ status: "error", reason: "title_required" });
});

it("cannot silently coerce a time-specific request into a date-only Task Proposal", () => {
  const tool = createPrepareDetailedTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = tool.inputSchema as unknown as {
    safeParse(input: unknown): { success: boolean };
  };
  expect(schema.safeParse({ title: "Take medicine", dueDate: "2026-08-03T09:00" }).success)
    .toBe(false);
  expect(tool.description).toContain("offer a Calendar Event Proposal instead");
});
