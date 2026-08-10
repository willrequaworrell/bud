import { mockModel } from "eve/evals";
import type { ToolContext } from "eve/tools";
import { generateText, stepCountIs, tool as modelTool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCreateTaskTool, createPrepareDatedTaskTool, createPrepareNotedTaskTool,
  createPrepareTaskTool,
} from "../agent/lib/tasks-tool.js";
import { createFakeCreationGuard } from "../agent/lib/creation-guard.js";
import { createTasks, type TasksAdapter } from "../agent/lib/tasks.js";

function context(principalId = "telegram:42"): ToolContext {
  return { callId: "call-123", session: { auth: { current: { principalId } } } } as ToolContext;
}

function adapter(createTask = vi.fn(async () => ({ taskId: "task-1" }))): TasksAdapter {
  return { createTask, async listIncomplete() { return { tasks: [], truncated: false }; } };
}

it("prepares immutable title-only, dated, and noted Prepared Tasks", async () => {
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
    { status: "ok", preparedTask: { title: "Buy milk", dueDate: null, notes: null,
      preparedWriteId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    { status: "ok", preparedTask: { title: "Submit report", dueDate: "2026-08-05", notes: null,
      preparedWriteId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    { status: "ok", preparedTask: { title: "Submit report", dueDate: "2026-08-05",
      notes: "Needs manager approval", preparedWriteId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
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
    status: "ok", preparedTask: { title: "Buy milk", dueDate: null, notes: null,
      preparedWriteId: expect.any(String) },
  });
  expect(await dated.execute(datedInput, context())).toEqual({
    status: "ok", preparedTask: { title: "Submit report", dueDate: "2026-08-05", notes: null,
      preparedWriteId: expect.any(String) },
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
      status: "ok", preparedTask: { title: "due tomorrow report", dueDate: null, notes: null,
        preparedWriteId: expect.any(String) },
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
  expect((generated.toolResults[0]?.output as { preparedTask: { notes: string | null } })
    .preparedTask.notes).toBe(expectedNotes);
});

it("changes Prepared Write identity when any displayed Task detail changes", async () => {
  const basic = createPrepareTaskTool({ adapter: adapter(), ownerId: "42" });
  const noted = createPrepareNotedTaskTool({ adapter: adapter(), ownerId: "42" });
  const original = await basic.execute({ title: "Buy milk" }, context());
  const revised = await noted.execute({ title: "Buy milk", notes: "Organic" }, context());
  if (original.status !== "ok" || revised.status !== "ok") throw new Error("expected Prepared Tasks");
  expect(revised.preparedTask.preparedWriteId).not.toBe(original.preparedTask.preparedWriteId);
});

it("rejects a reconstructed Prepared Task before displaying an Approval Request", async () => {
  const tasks = adapter();
  const prepare = createPrepareTaskTool({ adapter: tasks, ownerId: "42" });
  const create = createCreateTaskTool({
    adapter: tasks, guard: createFakeCreationGuard(), ownerId: "42",
  });
  const prepared = await prepare.execute({ title: "Fit mouthguard" }, context());
  if (prepared.status !== "ok") throw new Error("expected Prepared Task");
  const schema = create.inputSchema as unknown as {
    safeParse(input: unknown): { success: boolean };
  };

  expect(schema.safeParse({ preparedTask: {
    ...prepared.preparedTask, dueDate: "2026-08-03", notes: ".",
  } }).success).toBe(false);
});

it("automatically creates exactly one unchanged Prepared Task when the guard permits it", async () => {
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const tasks = adapter(createTask);
  const prepare = createPrepareDatedTaskTool({ adapter: tasks, ownerId: "42" });
  const guard = createFakeCreationGuard(["automatic"]);
  const create = createCreateTaskTool({ adapter: tasks, guard, ownerId: "42" });
  const prepared = await prepare.execute({ title: "Buy milk", dueDate: "2026-08-03" }, context());
  if (prepared.status !== "ok") throw new Error("expected Prepared Task");

  expect(await create.approval!({
    callId: "call-123", session: { id: "session-1", auth: { current: { principalId: "telegram:42" } },
      turn: { id: "turn-1" } },
  } as never)).toBe("not-applicable");
  expect(createTask).not.toHaveBeenCalled();
  expect(await create.execute({ preparedTask: prepared.preparedTask }, context()))
    .toEqual({ status: "ok", taskId: "task-1" });
  expect(createTask).toHaveBeenCalledWith({
    title: "Buy milk", notes: null, dueDate: "2026-08-03", idempotencyKey: "call-123",
  });
});

it.each([
  ["title-only", { title: "Buy milk" }, { title: "Buy milk", dueDate: null, notes: null }],
  ["dated", { title: "Buy milk", dueDate: "2026-08-03" },
    { title: "Buy milk", dueDate: "2026-08-03", notes: null }],
  ["noted", { title: "Buy milk", dueDate: "2026-08-03", notes: "Use whole milk" },
    { title: "Buy milk", dueDate: "2026-08-03", notes: "Use whole milk" }],
] as const)("preserves every %s Prepared Task field through automatic creation", async (
  _kind, input, expectedTask,
) => {
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const tasks = adapter(createTask);
  const prepared = createTasks(tasks).prepareTask(input);
  if (prepared.status !== "ok") throw new Error("expected Prepared Task");
  const create = createCreateTaskTool({
    adapter: tasks, guard: createFakeCreationGuard(["automatic"]), ownerId: "42",
  });

  await expect(create.execute({ preparedTask: prepared.preparedTask }, context()))
    .resolves.toEqual({ status: "ok", taskId: "task-1" });
  expect(createTask).toHaveBeenCalledWith({ ...expectedTask, idempotencyKey: "call-123" });
});

it("makes an Approval Request when automatic Task creation is unavailable", async () => {
  const tasks = adapter();
  const create = createCreateTaskTool({
    adapter: tasks, guard: createFakeCreationGuard(["approval-request"]), ownerId: "42",
  });

  await expect(create.approval!({
    callId: "call-123", session: { id: "session-1", auth: { current: { principalId: "telegram:42" } },
      turn: { id: "turn-1" } },
  } as never)).resolves.toBe("user-approval");
});

it("rejects a changed or unauthorized Prepared Task without writing", async () => {
  const createTask = vi.fn(async () => ({ taskId: "task-1" }));
  const tasks = adapter(createTask);
  const prepare = createPrepareTaskTool({ adapter: tasks, ownerId: "42" });
  const create = createCreateTaskTool({ adapter: tasks, guard: createFakeCreationGuard(), ownerId: "42" });
  const prepared = await prepare.execute({ title: "Buy milk" }, context());
  if (prepared.status !== "ok") throw new Error("expected Prepared Task");

  await expect(create.execute({
    preparedTask: { ...prepared.preparedTask, title: "Changed" },
  }, context())).resolves.toEqual({ status: "error", reason: "prepared_write_changed" });
  await expect(create.execute({ preparedTask: prepared.preparedTask }, context("telegram:99")))
    .resolves.toEqual({ status: "error", reason: "forbidden" });
  expect(createTask).not.toHaveBeenCalled();
});

it.each(["", "   "])("requires a non-empty Task title", async (title) => {
  const tool = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  await expect(tool.execute({ title, dueDate: "2026-08-03" }, context()))
    .resolves.toEqual({ status: "error", reason: "title_required" });
});

it("cannot silently coerce a time-specific request into a date-only Prepared Task", () => {
  const tool = createPrepareDatedTaskTool({ adapter: adapter(), ownerId: "42" });
  const schema = tool.inputSchema as unknown as {
    safeParse(input: unknown): { success: boolean };
  };
  expect(schema.safeParse({ title: "Take medicine", dueDate: "2026-08-03T09:00" }).success)
    .toBe(false);
  expect(tool.description).toContain("offer a Prepared Event instead");
});
