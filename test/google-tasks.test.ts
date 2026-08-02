import { expect, it, vi } from "vitest";

import { createGoogleTasksAdapter, TasksAdapterError } from "../agent/lib/google-tasks.js";

it("reads only incomplete Tasks from the configured list and strips Google fields", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ items: [
    { id: "private-task-id", title: "Pay rent", due: "2026-08-03T00:00:00.000Z",
      status: "needsAction", selfLink: "https://private.example/task", notes: "secret metadata" },
    { id: "another-id", title: "Call Sam", status: "needsAction" },
  ] }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "private-list-id",
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.listIncomplete(25)).resolves.toEqual({
    tasks: [
      { dueDate: "2026-08-03", title: "Pay rent" },
      { title: "Call Sam" },
    ],
    truncated: false,
  });
  const url = String(request.mock.calls[0]?.[0]);
  expect(url).toContain("/tasks/v1/lists/private-list-id/tasks?");
  expect(url).toContain("showCompleted=false");
  expect(url).toContain("showHidden=false");
  expect(url).toContain("maxResults=26");
});

it("signals truncation after returning the configured number of Tasks", async () => {
  const items = Array.from({ length: 4 }, (_, index) => ({
    id: `id-${index}`, status: "needsAction", title: `Task ${index}`,
  }));
  const adapter = createGoogleTasksAdapter({
    fetch: async () => Response.json({ items }), listId: "list",
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.listIncomplete(3)).resolves.toEqual({
    tasks: [{ title: "Task 0" }, { title: "Task 1" }, { title: "Task 2" }],
    truncated: true,
  });
});

it.each([[429, "rate_limited"], [500, "unavailable"]] as const)(
  "maps Google Tasks status %s to %s", async (status, failure) => {
    const adapter = createGoogleTasksAdapter({
      fetch: async () => new Response("{}", { status }), listId: "list",
      tokenProvider: { async getAccessToken() { return "token"; } },
    });

    await expect(adapter.listIncomplete(25)).rejects.toEqual(new TasksAdapterError(failure));
  },
);
