import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { mockModel } from "eve/evals";
import type { ToolContext } from "eve/tools";
import { generateText, stepCountIs, tool as modelTool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { BudConfig } from "../agent/lib/config.js";
import { createListIncompleteTasksTool } from "../agent/lib/tasks-tool.js";
import { TasksAdapterError, type TasksAdapter } from "../agent/lib/tasks.js";
import { createBudTelegramChannel } from "../agent/lib/telegram-channel.js";

const config: BudConfig = {
  assistantName: "Bud", googleCalendarId: "primary", googleCalendarReadIds: ["primary"],
  googleOAuthClientId: "client", googleOAuthClientSecret: "secret",
  googleOAuthRefreshToken: "refresh", googleTasksListId: "private-list-id",
  modelId: "test/deterministic", ownerId: "42", tasksResultLimit: 25,
  telegramBotToken: "bot", telegramWebhookSecret: "webhook",
  transcriptionMaxBytes: 10 * 1024 * 1024,
  transcriptionMaxDurationSeconds: 5 * 60,
  transcriptionModel: "test-transcriber",
};

function render(result: Awaited<ReturnType<ReturnType<typeof createListIncompleteTasksTool>["execute"]>>) {
  if (result.status === "error") {
    if (result.reason === "rate_limited") return "Google Tasks is rate-limited. Please try again shortly.";
    return "Google Tasks is unavailable right now. Please try again later.";
  }
  const groups = [
    ["Overdue", result.overdue], ["Upcoming", result.upcoming], ["Undated", result.undated],
  ] as const;
  const lines = groups.flatMap(([label, tasks]) => tasks.length
    ? [label, ...tasks.map((task) => `- ${task.title}${task.dueDate ? ` — ${task.dueDate}` : ""}`)]
    : []);
  if (lines.length === 0) return "You have no incomplete Tasks.";
  if (result.truncated) {
    lines.push("More Tasks exist. Try a narrower request.");
  }
  return lines.join("\n");
}

async function askForTasks(adapter: TasksAdapter) {
  const outbound: string[] = [];
  const telegramFetch = vi.fn<typeof fetch>(async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) outbound.push(body.text);
    return Response.json({ ok: true, result: { message_id: 8, chat: { id: 42, type: "private" } } });
  });
  const tool = createListIncompleteTasksTool({
    adapter, now: () => new Date("2026-08-02T16:00:00Z"), ownerId: "42",
    resultLimit: config.tasksResultLimit, timeZone: "America/New_York",
  });
  const model = mockModel(({ toolResults, tools }) => {
    if (toolResults.length === 0) {
      expect(tools.map(({ name }) => name)).toContain("list_incomplete_tasks");
      return { toolCalls: [{ input: {}, name: "list_incomplete_tasks" }] };
    }
    expect(JSON.stringify(toolResults)).not.toContain(config.googleTasksListId);
    return render(toolResults.at(-1)!.output as Awaited<ReturnType<typeof tool.execute>>);
  });
  const channel = createBudTelegramChannel(config, { telegramFetch });
  const pending: Promise<unknown>[] = [];
  const args = {
    async send(input: unknown, options: { state: TelegramChannelState }) {
      const message = (input as { message: string }).message;
      const result = await generateText({
        model,
        prompt: message,
        stopWhen: stepCountIs(2),
        tools: {
          list_incomplete_tasks: modelTool({
            description: tool.description,
            inputSchema: z.object({}),
            execute: () => tool.execute({}, {
              callId: "call", session: { auth: { current: { principalId: "telegram:42" } } },
            } as ToolContext),
          }),
        },
      });
      await (channel as any).adapter.createAdapterContext({
        ctx: {}, session: { continuationToken: "token", setContinuationToken() {} },
        state: options.state,
      }).telegram.sendMessage(result.text);
      return { id: "session" } as Session;
    },
    waitUntil(task: Promise<unknown>) { pending.push(task); },
    async resolveActiveSession() { return undefined; },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;
  await channel.routes[0]!.handler(new Request("https://bud.test/eve/v1/telegram", {
    method: "POST",
    headers: { "content-type": "application/json",
      "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 7, date: 0,
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Owner" },
      text: "What are my tasks?" } }),
  }), args);
  await Promise.all(pending);
  return outbound;
}

describe("Tasks through the Telegram Channel", () => {
  it("reports an empty incomplete Tasks list", async () => {
    expect(await askForTasks({ async listIncomplete() { return { tasks: [], truncated: false }; } }))
      .toEqual(["You have no incomplete Tasks."]);
  });

  it("groups populated Tasks as overdue, upcoming, and undated", async () => {
    expect(await askForTasks({ async listIncomplete() { return { truncated: false, tasks: [
      { dueDate: "2026-08-01", title: "Late" }, { dueDate: "2026-08-03", title: "Soon" },
      { title: "Someday" },
    ] }; } })).toEqual([
      "Overdue\n- Late — 2026-08-01\nUpcoming\n- Soon — 2026-08-03\nUndated\n- Someday",
    ]);
  });

  it("signals a truncated result and suggests narrowing", async () => {
    expect(await askForTasks({ async listIncomplete() {
      return { tasks: [{ title: "One of many" }], truncated: true };
    } })).toEqual(["Undated\n- One of many\nMore Tasks exist. Try a narrower request."]);
  });

  it.each([
    ["rate_limited", "Google Tasks is rate-limited. Please try again shortly."],
    ["unavailable", "Google Tasks is unavailable right now. Please try again later."],
  ] as const)("reports a %s Google Tasks response", async (failure, message) => {
    expect(await askForTasks({ async listIncomplete() { throw new TasksAdapterError(failure); } }))
      .toEqual([message]);
  });
});
