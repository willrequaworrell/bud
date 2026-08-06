import { mockModel } from "eve/evals";
import type { ToolContext } from "eve/tools";
import { generateText, stepCountIs, tool as modelTool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCreateTaskTool, createPrepareDatedTaskTool, createPrepareNotedTaskTool,
  createPrepareTaskTool,
} from "../agent/lib/tasks-tool.js";
import type { TasksAdapter } from "../agent/lib/tasks.js";

function context(principalId = "telegram:42"): ToolContext {
  return { callId: "call-123", session: { auth: { current: { principalId } } } } as ToolContext;
}

function adapter(createTask = vi.fn(async () => ({ taskId: "task-1" }))): TasksAdapter {
  return { createTask, async listIncomplete() { return { tasks: [], truncated: false }; } };
}

it("prepares immutable title-only, dated, and noted Task Proposals", async () => {
  const options = { adapter: adapter(), ownerId: "42" };
  const prepared = await Promise.all([
    createPrepareTaskTool(options).execute({ title: "Buy milk" }, context()),
    createPrepareDatedTaskTool(options).execute({
      title: "Submit report", dueDate: "2026-08-05",
    }, context()),
    createPrepareNotedTaskTool(options).execute({
      title: "Submit report", dueDate: "2026-08-05", notes: "Needs manager approval",
    }, context()),
  ]);

  expect(prepared).toEqual([
    { status: "ok", proposal: { title: "Buy milk", dueDate: null, notes: null,
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    { status: "ok", proposal: { title: "Submit report", dueDate: "2026-08-05", notes: null,
      proposalId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    { status: "ok", proposal: { title: "Submit report", dueDate: "2026-08-05",
      notes: "Needs manager approval", proposalId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
  ]);
});

it("structurally prevents title-only and dated Task tools from accepting notes", async () => {
  const basic = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const dated = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  const basicInput = (basic.inputSchema as unknown as { parse(value: unknown): { title: string } })
    .parse({ title: "Buy milk", dueDate: "2026-08-05", notes: "invented" });
  const datedInput = (dated.inputSchema as unknown as {
    parse(value: unknown): { title: string; dueDate: string };
  }).parse({ title: "Submit report", dueDate: "2026-08-05", notes: "due tomorrow" });

  expect(await basic.execute(basicInput, context())).toEqual({
    status: "ok", proposal: { title: "Buy milk", dueDate: null, notes: null,
      proposalId: expect.any(String) },
  });
  expect(await dated.execute(datedInput, context())).toEqual({
    status: "ok", proposal: { title: "Submit report", dueDate: "2026-08-05", notes: null,
      proposalId: expect.any(String) },
  });
});

it("requires explicit note content at the noted Task interface", () => {
  const tool = createPrepareNotedTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = tool.inputSchema as unknown as { safeParse(value: unknown): { success: boolean } };

  expect(schema.safeParse({ title: "Submit report", dueDate: "2026-08-05" }).success).toBe(false);
  expect(schema.safeParse({ title: "Submit report", notes: "" }).success).toBe(false);
  expect(schema.safeParse({ title: "Submit report", notes: "Needs approval" }).success).toBe(true);
});

it("accepts date-like words when they are the literal Task title", async () => {
  const tool = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });

  await expect(tool.execute({ title: "\"due tomorrow report\"" }, context()))
    .resolves.toEqual({
      status: "ok", proposal: { title: "due tomorrow report", dueDate: null, notes: null,
        proposalId: expect.any(String) },
    });
  expect(tool.description).toContain("Do not ask for a different title merely because");
});

it("keeps title schema guidance from rejecting literal date-like titles", () => {
  const basic = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const dated = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  const noted = createPrepareNotedTaskTool({ adapter: adapter(), ownerId: "42" });

  const schemaText = [
    JSON.stringify((basic.inputSchema as z.ZodType).def),
    JSON.stringify((dated.inputSchema as z.ZodType).def),
    JSON.stringify((noted.inputSchema as z.ZodType).def),
    basic.description,
    dated.description,
    noted.description,
  ].join("\n");

  expect(schemaText).not.toContain("without due-date language");
  expect(schemaText).toContain("date-like words can be part of the literal title");
});

it.each([
  ["Create Submit report, due tomorrow", "prepare_dated_task",
    { title: "Submit report", dueDate: "2026-08-05" }, null],
  ["Create Submit report, due tomorrow, with a note that it needs manager approval",
    "prepare_noted_task", { title: "Submit report", dueDate: "2026-08-05",
      notes: "Needs manager approval" }, "Needs manager approval"],
] as const)("exposes the structurally appropriate model tool for: %s", async (
  request, selectedTool, input, expectedNotes,
) => {
  const dated = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  const noted = createPrepareNotedTaskTool({ adapter: adapter(), ownerId: "42" });
  const model = mockModel(({ toolResults, tools }) => {
    if (toolResults.length > 0) return "Prepared";
    expect(tools.find(({ name }) => name === "prepare_dated_task")?.description)
      .toContain("structurally cannot add notes");
    expect(tools.find(({ name }) => name === "prepare_noted_task")?.description)
      .toContain("explicitly asks to add meaningful note content");
    return { toolCalls: [{ name: selectedTool, input }] };
  });
  const generated = await generateText({
    model, prompt: request, stopWhen: stepCountIs(2),
    tools: {
      prepare_dated_task: modelTool({
        description: dated.description,
        inputSchema: z.object({ title: z.string(), dueDate: z.iso.date() }),
        execute: (value) => dated.execute(value, context()),
      }),
      prepare_noted_task: modelTool({
        description: noted.description,
        inputSchema: z.object({
          title: z.string(), notes: z.string().min(1), dueDate: z.iso.date().optional(),
        }),
        execute: (value) => noted.execute(value, context()),
      }),
    },
  });

  expect(generated.toolCalls[0]?.toolName).toBe(selectedTool);
  expect((generated.toolResults[0]?.output as { proposal: { notes: string | null } })
    .proposal.notes).toBe(expectedNotes);
});

it("changes Proposal identity when any displayed Task detail changes", async () => {
  const basic = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const noted = createPrepareNotedTaskTool({ adapter: adapter(), ownerId: "42" });
  const original = await basic.execute({ title: "Buy milk" }, context());
  const revised = await noted.execute({ title: "Buy milk", notes: "Organic" }, context());
  if (original.status !== "ok" || revised.status !== "ok") throw new Error("expected proposals");
  expect(revised.proposal.proposalId).not.toBe(original.proposal.proposalId);
});

it("rejects a reconstructed Proposal before displaying an approval", async () => {
  const tasks = adapter();
  const prepare = createPrepareTaskTool({ adapter: tasks, ownerId: "42" });
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
  const prepare = createPrepareDatedTaskTool({ adapter: tasks, ownerId: "42" });
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
  const tool = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  await expect(tool.execute({ title, dueDate: "2026-08-03" }, context()))
    .resolves.toEqual({ status: "error", reason: "title_required" });
});

it("cannot silently coerce a time-specific request into a date-only Task Proposal", () => {
  const tool = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = tool.inputSchema as unknown as {
    safeParse(input: unknown): { success: boolean };
  };
  expect(schema.safeParse({ title: "Take medicine", dueDate: "2026-08-03T09:00" }).success)
    .toBe(false);
  expect(tool.description).toContain("offer a Calendar Event Proposal instead");
});
