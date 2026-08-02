import { TasksAdapterError, type TasksAdapter, type TasksFailure } from "./tasks.js";
import { TokenProviderError, type TokenProvider } from "./token-provider.js";

interface GoogleTasksOptions {
  fetch?: typeof fetch;
  listId: string;
  tokenProvider: TokenProvider;
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
  return {
    async listIncomplete(limit) {
      let token: string;
      try {
        token = await options.tokenProvider.getAccessToken();
      } catch (error) {
        if (error instanceof TokenProviderError) throw new TasksAdapterError(error.reason);
        throw new TasksAdapterError("unavailable");
      }
      const query = new URLSearchParams({
        fields: "items(title,due,status),nextPageToken",
        maxResults: String(Math.min(limit + 1, 100)),
        showCompleted: "false",
        showHidden: "false",
      });
      let response: Response;
      try {
        response = await request(
          `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(options.listId)}/tasks?${query}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
      } catch {
        throw new TasksAdapterError("unavailable");
      }
      if (!response.ok) throw new TasksAdapterError(failureForStatus(response.status));
      const payload = await response.json() as {
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
