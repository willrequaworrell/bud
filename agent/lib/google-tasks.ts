import { TasksAdapterError, type TasksAdapter, type TasksFailure, type TaskWrite } from "./tasks.js";
import { TokenProviderError, type TokenProvider } from "./token-provider.js";

interface GoogleTasksOptions {
  fetch?: typeof fetch;
  listId: string;
  tokenProvider: TokenProvider;
}

class AmbiguousTaskInsert extends Error {}
class AmbiguousTaskOutcome extends TasksAdapterError {
  constructor() { super("unavailable"); }
}

function failureForStatus(status: number): TasksFailure {
  if (status === 401) return "authentication_expired";
  if (status === 403) return "access_revoked";
  if (status === 429) return "rate_limited";
  return "unavailable";
}

export { TasksAdapterError } from "./tasks.js";

export function createGoogleTasksAdapter(options: GoogleTasksOptions): TasksAdapter {
  const request = options.fetch ?? fetch;
  const tasksPath = `/lists/${encodeURIComponent(options.listId)}/tasks`;
  const executions = new Map<string, Promise<{ taskId: string }>>();

  async function accessToken() {
    try {
      return await options.tokenProvider.getAccessToken();
    } catch (error) {
      if (error instanceof TokenProviderError) throw new TasksAdapterError(error.reason);
      throw new TasksAdapterError("unavailable");
    }
  }

  async function googleRequest(path: string, init: RequestInit = {}) {
    const token = await accessToken();
    let response: Response;
    try {
      response = await request(`https://tasks.googleapis.com/tasks/v1${path}`, {
        ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
      });
    } catch {
      if (init.method === "POST") throw new AmbiguousTaskInsert();
      throw new TasksAdapterError("unavailable");
    }
    if (!response.ok) {
      if (init.method === "POST" && response.status >= 500) throw new AmbiguousTaskInsert();
      throw new TasksAdapterError(failureForStatus(response.status));
    }
    try {
      return await response.json() as unknown;
    } catch {
      if (init.method === "POST") throw new AmbiguousTaskInsert();
      throw new TasksAdapterError("unavailable");
    }
  }

  function googleDue(dueDate: string | null) {
    return dueDate ? `${dueDate}T00:00:00.000Z` : undefined;
  }

  function matchesTask(item: { title?: string; notes?: string; due?: string }, task: TaskWrite) {
    return item.title === task.title && (item.notes ?? null) === task.notes &&
      (item.due?.slice(0, 10) ?? null) === task.dueDate;
  }

  async function findAmbiguousInsert(task: TaskWrite, startedAt: Date) {
    const query = new URLSearchParams({
      fields: "items(id,title,notes,due,status,updated),nextPageToken", showCompleted: "true",
      showHidden: "true", updatedMin: new Date(startedAt.getTime() - 5_000).toISOString(),
    });
    const latestMatch = startedAt.getTime() + 5_000;
    const exact: Array<{ id: string }> = [];
    let pageToken: string | undefined;
    do {
      if (pageToken) query.set("pageToken", pageToken);
      const payload = await googleRequest(`${tasksPath}?${query}`) as { items?: Array<{
        id?: string; title?: string; notes?: string; due?: string; updated?: string;
      }>; nextPageToken?: string };
      exact.push(...(payload.items ?? []).flatMap((item) => {
        const updated = item.updated ? new Date(item.updated).getTime() : Number.NaN;
        return item.id && updated <= latestMatch && matchesTask(item, task) ? [{ id: item.id }] : [];
      }));
      pageToken = payload.nextPageToken;
    } while (pageToken);
    if (exact.length !== 1) throw new TasksAdapterError("unavailable");
    return { taskId: exact[0]!.id };
  }

  return {
    createTask(task) {
      const prior = executions.get(task.idempotencyKey);
      if (prior) return prior;
      const execution = (async () => {
        const startedAt = new Date();
        const body = {
          title: task.title,
          ...(task.notes ? { notes: task.notes } : {}),
          ...(task.dueDate ? { due: googleDue(task.dueDate) } : {}),
        };
        try {
          const payload = await googleRequest(tasksPath, {
            method: "POST", body: JSON.stringify(body),
          }) as { id?: string };
          if (!payload.id) throw new AmbiguousTaskInsert();
          return { taskId: payload.id };
        } catch (error) {
          if (!(error instanceof AmbiguousTaskInsert)) throw error;
          return findAmbiguousInsert(task, startedAt).catch(() => {
            throw new AmbiguousTaskOutcome();
          });
        }
      })();
      executions.set(task.idempotencyKey, execution);
      execution.catch((error) => {
        if (!(error instanceof AmbiguousTaskOutcome)) executions.delete(task.idempotencyKey);
      });
      return execution;
    },
    async listIncomplete(limit) {
      const query = new URLSearchParams({
        fields: "items(title,due,status),nextPageToken",
        maxResults: String(Math.min(limit + 1, 100)),
        showCompleted: "false",
        showHidden: "false",
      });
      const payload = await googleRequest(`${tasksPath}?${query}`) as {
        items?: Array<{ due?: string; status?: string; title?: string }>;
        nextPageToken?: string;
      };
      const incomplete = (payload.items ?? []).filter(
        (item) => item.status === undefined || item.status === "needsAction",
      );
      return {
        tasks: incomplete.slice(0, limit).map((item) => ({
          ...(item.due ? { dueDate: item.due.slice(0, 10) } : {}),
          title: item.title?.trim() || "Untitled Task",
        })),
        truncated: incomplete.length > limit || payload.nextPageToken !== undefined,
      };
    },
  };
}
