import type { ToolContext } from "eve/tools";
import { expect, it, vi } from "vitest";

import { createListIncompleteTasksTool } from "../agent/lib/tasks-tool.js";

function context(principalId: string): ToolContext {
  return { callId: "call-123", session: { auth: { current: { principalId } } } } as ToolContext;
}

it("groups incomplete Tasks without exposing provider data", async () => {
  const listIncomplete = vi.fn(async () => ({
    tasks: [
      { title: "No date" },
      { dueDate: "2026-08-01", title: "Late" },
      { dueDate: "2026-08-02", title: "Today" },
      { dueDate: "2026-08-05", title: "Soon" },
    ],
    truncated: false,
  }));
  const tool = createListIncompleteTasksTool({
    adapter: { listIncomplete },
    now: () => new Date("2026-08-02T16:00:00Z"),
    ownerId: "42",
    resultLimit: 25,
    timeZone: "America/New_York",
  });

  const result = await tool.execute({}, context("telegram:42"));

  expect(result).toEqual({
    status: "ok",
    overdue: [{ dueDate: "2026-08-01", title: "Late" }],
    upcoming: [
      { dueDate: "2026-08-02", title: "Today" },
      { dueDate: "2026-08-05", title: "Soon" },
    ],
    undated: [{ title: "No date" }],
    truncated: false,
  });
  expect(listIncomplete).toHaveBeenCalledWith(25);
  expect(JSON.stringify(result)).not.toContain("private-list");
});

it("re-enforces Owner authorization inside the Tasks tool", async () => {
  const listIncomplete = vi.fn(async () => ({ tasks: [], truncated: false }));
  const tool = createListIncompleteTasksTool({
    adapter: { listIncomplete }, ownerId: "42", resultLimit: 25, timeZone: "UTC",
  });

  expect(await tool.execute({}, context("telegram:99")))
    .toEqual({ status: "error", reason: "forbidden" });
  expect(listIncomplete).not.toHaveBeenCalled();
});
