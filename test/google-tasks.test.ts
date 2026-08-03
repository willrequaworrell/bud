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

it("creates an undated Task with exactly the displayed fields", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ id: "created-id" }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "private-list-id",
    tokenProvider: { async getAccessToken() { return "token"; } },
  });

  await expect(adapter.createTask!({
    title: "Buy milk", notes: "Get oat milk", dueDate: null, idempotencyKey: "call-1",
  })).resolves.toEqual({ taskId: "created-id" });
  const [url, init] = request.mock.calls[0]!;
  expect(String(url)).toBe("https://tasks.googleapis.com/tasks/v1/lists/private-list-id/tasks");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ title: "Buy milk", notes: "Get oat milk" });
});

it("sends a date-only Google Tasks due value", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ id: "created-id" }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await adapter.createTask!({ title: "File taxes", notes: null,
    dueDate: "2026-08-03", idempotencyKey: "call-1" });
  expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({
    title: "File taxes", due: "2026-08-03T00:00:00.000Z",
  });
});

it("uses a narrow exact duplicate guard after an ambiguous insert outcome", async () => {
  const request = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") throw new TypeError("connection reset");
    return Response.json({ items: [{ id: "created-id", title: "Buy milk", notes: "Get oat milk",
      due: "2026-08-03T00:00:00.000Z", status: "needsAction", updated: new Date().toISOString() }] });
  });
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: "Get oat milk",
    dueDate: "2026-08-03", idempotencyKey: "call-1" }))
    .resolves.toEqual({ taskId: "created-id" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("does not claim success when an ambiguous outcome has no unique exact match", async () => {
  const request = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") throw new TypeError("connection reset");
    return Response.json({ items: [] });
  });
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: null,
    dueDate: null, idempotencyKey: "call-1" }))
    .rejects.toMatchObject({ failure: "unavailable" });
});

it("does not run duplicate recovery when token acquisition fails before insert", async () => {
  const request = vi.fn<typeof fetch>();
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() {
      throw new Error("token unavailable");
    } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: null,
    dueDate: null, idempotencyKey: "call-1" }))
    .rejects.toEqual(new TasksAdapterError("unavailable"));
  expect(request).not.toHaveBeenCalled();
});

it("does not claim success or run recovery for a definitive Google API failure", async () => {
  const request = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: null,
    dueDate: null, idempotencyKey: "call-1" }))
    .rejects.toEqual(new TasksAdapterError("access_revoked"));
  expect(request).toHaveBeenCalledTimes(1);
});

it("uses duplicate recovery for an ambiguous Google server outcome", async () => {
  const request = vi.fn<typeof fetch>(async (_input, init) => init?.method === "POST"
    ? new Response("{}", { status: 503 })
    : Response.json({ items: [{ id: "created-id", title: "Buy milk",
      updated: new Date().toISOString() }] }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: null,
    dueDate: null, idempotencyKey: "call-1" }))
    .resolves.toEqual({ taskId: "created-id" });
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["malformed", "missing-id"] as const)(
  "uses duplicate recovery for an ambiguous successful response: %s", async (responseKind) => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        return responseKind === "malformed"
          ? new Response("not-json", { status: 200 })
          : Response.json({});
      }
      return Response.json({ items: [{ id: "created-id", title: "Buy milk",
        updated: new Date().toISOString() }] });
    });
    const adapter = createGoogleTasksAdapter({
      fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
    });
    await expect(adapter.createTask!({ title: "Buy milk", notes: null,
      dueDate: null, idempotencyKey: "call-1" }))
      .resolves.toEqual({ taskId: "created-id" });
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("does not reinsert after an ambiguous outcome remains unconfirmed", async () => {
  const request = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") throw new TypeError("connection reset");
    return Response.json({ items: [] });
  });
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  const task = { title: "Buy milk", notes: null, dueDate: null, idempotencyKey: "same-call" };
  await expect(adapter.createTask!(task)).rejects.toMatchObject({ failure: "unavailable" });
  await expect(adapter.createTask!(task)).rejects.toMatchObject({ failure: "unavailable" });
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects an ambiguous insert when another exact match exists on a later page", async () => {
  let page = 0;
  const matching = () => ({ id: `match-${page}`, title: "Buy milk", status: "needsAction",
    updated: new Date().toISOString() });
  const request = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === "POST") throw new TypeError("connection reset");
    page += 1;
    return Response.json(page === 1
      ? { items: [matching()], nextPageToken: "next" }
      : { items: [matching()] });
  });
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  await expect(adapter.createTask!({ title: "Buy milk", notes: null,
    dueDate: null, idempotencyKey: "call-1" }))
    .rejects.toMatchObject({ failure: "unavailable" });
  expect(request).toHaveBeenCalledTimes(3);
});

it("does not repeat an insert when the same approval execution is delivered twice", async () => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ id: "created-id" }));
  const adapter = createGoogleTasksAdapter({
    fetch: request, listId: "list", tokenProvider: { async getAccessToken() { return "token"; } },
  });
  const task = { title: "Buy milk", notes: null, dueDate: null, idempotencyKey: "same-call" };
  await expect(Promise.all([adapter.createTask!(task), adapter.createTask!(task)]))
    .resolves.toEqual([{ taskId: "created-id" }, { taskId: "created-id" }]);
  expect(request).toHaveBeenCalledTimes(1);
});
