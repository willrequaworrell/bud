import type { RouteHandlerArgs, Session } from "eve/channels";
import type { TelegramChannelState } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { BudConfig } from "../agent/lib/config.js";
import {
  createBudTelegramChannel,
  handleTelegramInputRequested,
} from "../agent/lib/telegram-channel.js";
import type { TranscriptionAdapter } from "../agent/lib/transcription.js";

const config: BudConfig = {
  assistantName: "Bud", googleCalendarId: "primary", googleOAuthClientId: "client",
  googleCalendarReadIds: ["primary"],
  googleTasksListId: "@default",
  googleOAuthClientSecret: "secret", googleOAuthRefreshToken: "refresh",
  modelId: "test/deterministic", ownerId: "42", telegramBotToken: "bot",
  telegramWebhookSecret: "webhook",
  tasksResultLimit: 25,
  transcriptionMaxBytes: 10 * 1024 * 1024,
  transcriptionMaxDurationSeconds: 5 * 60,
  transcriptionModel: "test-transcriber",
};

function update(senderId: number, text: string, chatType: "private" | "group" = "private") {
  return { update_id: 1, message: { message_id: 7, date: 0,
    chat: { id: senderId, type: chatType },
    from: { id: senderId, is_bot: false, first_name: "Sender" }, text } };
}

function callbackUpdate(senderId: number, data: string) {
  return { update_id: 2, callback_query: { id: "callback-1", data,
    from: { id: senderId, is_bot: false, first_name: "Sender" },
    message: { message_id: 8, date: 0, chat: { id: senderId, type: "private" },
      from: { id: 100, is_bot: true, first_name: "Bud" }, text: "Approve?" } } };
}

function mediaUpdate(
  field: "audio" | "document" | "photo" | "video" | "voice",
  value: unknown,
  senderId = 42,
) {
  return { update_id: 3, message: { message_id: 9, date: 0,
    chat: { id: senderId, type: "private" },
    from: { id: senderId, is_bot: false, first_name: "Sender" }, [field]: value } };
}

async function deliverMedia(
  body: unknown,
  transcription: TranscriptionAdapter = { transcribe: vi.fn(async () => "What's next today?") },
  mediaOptions: {
    config?: BudConfig;
    downloadResponse?: () => Response;
    pendingProposal?: boolean;
    proposal?: "task";
    correctionClassifier?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const outbound: string[] = [];
  const model = vi.fn(async (message: string) => `Model: ${message}`);
  const telegramFetch = vi.fn<typeof fetch>(async (request, init) => {
    const url = String(request);
    if (url.includes("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "voice/file.ogg" } });
    }
    if (url.includes("/file/")) return mediaOptions.downloadResponse?.() ??
      new Response(new Uint8Array([1, 2, 3]));
    const requestBody = JSON.parse(String(init?.body)) as { text?: string };
    if (requestBody.text) outbound.push(requestBody.text);
    return Response.json({ ok: true, result: { message_id: 8, chat: { id: 42, type: "private" } } });
  });
  const channelConfig = mediaOptions.config ?? config;
  const channel = createBudTelegramChannel(channelConfig, {
    ...(mediaOptions.correctionClassifier
      ? { correctionClassifier: mediaOptions.correctionClassifier }
      : {}),
    telegramFetch, transcription,
  });
  const route = channel.routes[0]!;
  const tasks: Promise<unknown>[] = [];
  const send = vi.fn(async (input, sendOptions) => {
    const payload = input as { message: string };
    const runtime = {
      state: sendOptions.state, ctx: {}, session: {
        continuationToken: sendOptions.continuationToken, setContinuationToken() {},
      },
    };
    const telegram = (channel as any).adapter.createAdapterContext(runtime).telegram;
    const reply = await model(payload.message);
    if (mediaOptions.proposal === "task") {
      await handleTelegramInputRequested({ requests: [{
        action: { callId: "call-voice", kind: "tool-call", toolName: "create_task",
          input: { proposal: { title: "Buy milk", dueDate: null, notes: null,
            proposalId: "immutable-proposal" } } },
        allowFreeform: false, display: "confirmation",
        options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
        prompt: "Approve?", requestId: "approval-voice",
      }] } as never, { state: sendOptions.state, telegram } as never, {} as never);
    } else {
      await telegram.sendMessage(reply);
    }
    return { id: "session" } as Session;
  });
  await route.handler(new Request("https://bud.test/eve/v1/telegram", {
    method: "POST", headers: { "content-type": "application/json",
      "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
    body: JSON.stringify(body),
  }), {
    send, waitUntil(task: Promise<unknown>) { tasks.push(task); },
    async resolveActiveSession() {
      return mediaOptions.pendingProposal ? { sessionId: "session" } : undefined;
    },
    getSession() {
      return { getEventStream: async () => new ReadableStream({ start(controller) {
        controller.enqueue({ type: "input.requested", data: { requests: [{
          action: { kind: "tool-call", toolName: "create_task", callId: "pending-call",
            input: { proposal: { title: "Existing", dueDate: null, notes: null } } },
          requestId: "pending-approval", prompt: "Approve?",
        }], sequence: 0, stepIndex: 0, turnId: "turn" } });
        controller.enqueue({ type: "session.waiting", data: {
          continuationToken: "token", wait: "next-user-message",
        } });
        controller.close();
      } }) } as Session;
    },
  } as unknown as RouteHandlerArgs<TelegramChannelState>);
  await Promise.all(tasks);
  return { model, outbound, send, telegramFetch, transcription };
}

async function deliverWithSessionState(
  activeSession: boolean,
  pendingProposal: boolean | "resolved",
  proposalToolName = "create_calendar_event",
  correctionClassifier = vi.fn(async () => false),
  ...updates: unknown[]
) {
  const outbound: string[] = [];
  const authContexts: unknown[] = [];
  const eventStreamStartIndexes: Array<number | undefined> = [];
  const inputResponses: unknown[] = [];
  const replacementProposals: Array<Record<string, unknown>> = [];
  const model = vi.fn(async (message: string) => `Model: ${message}`);
  const telegramFetch = vi.fn<typeof fetch>(async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) outbound.push(body.text);
    return Response.json({ ok: true, result: { message_id: 8, chat: { id: 42, type: "private" } } });
  });
  const channel = createBudTelegramChannel(config, { correctionClassifier, telegramFetch });
  const route = channel.routes[0]!;
  const tasks: Promise<unknown>[] = [];
  const args = {
    send: vi.fn(async (input, options) => {
      authContexts.push(options.auth);
      const payload = input as { message?: string; inputResponses?: Array<{ requestId: string }> };
      if (payload.inputResponses) {
        inputResponses.push(...payload.inputResponses);
        await (channel as any).adapter.deliver(payload, {
          state: options.state as TelegramChannelState,
          ctx: {},
          session: { continuationToken: options.continuationToken, setContinuationToken() {} },
        });
        return { id: "session" } as Session;
      }
      const reply = await model(payload.message!);
      const runtime = { state: options.state as TelegramChannelState, ctx: {}, session: {
        continuationToken: options.continuationToken, setContinuationToken() {},
      } };
      const telegram = (channel as any).adapter.createAdapterContext(runtime).telegram;
      await telegram.sendMessage(reply);
      const replacementProposal = payload.message === 'Actually the title should be "due tomorrow report"'
        ? { title: "due tomorrow report", dueDate: null, notes: null, proposalId: "a".repeat(64) }
        : payload.message === "Wait, make that 1pm"
          ? { kind: "timed", title: "Practice", startLocal: "2026-08-03T13:00",
            endLocal: "2026-08-03T13:30", timeZone: "UTC", proposalId: "b".repeat(64) }
          : undefined;
      if (replacementProposal) {
        replacementProposals.push(replacementProposal);
        await handleTelegramInputRequested({ requests: [{
          action: { callId: "replacement-call", kind: "tool-call",
            toolName: "kind" in replacementProposal ? "create_calendar_event" : "create_task",
            input: { proposal: replacementProposal } },
          allowFreeform: false, display: "confirmation",
          options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
          prompt: "Approve?", requestId: "replacement-approval",
        }] } as never, { state: options.state, telegram } as never, {} as never);
      }
      return { id: "session" } as Session;
    }),
    waitUntil(task: Promise<unknown>) { tasks.push(task); },
    async resolveActiveSession() { return activeSession ? { sessionId: "session" } : undefined; },
    getSession() {
      return { getEventStream: async (options?: { startIndex?: number }) => {
        eventStreamStartIndexes.push(options?.startIndex);
        const events: any[] = [];
        if (pendingProposal) {
          events.push(
            { type: "input.requested", data: { requests: [], sequence: 0, stepIndex: 0,
              turnId: "historical-turn" } },
            { type: "session.waiting", data: {
              continuationToken: "historical-token", wait: "next-user-message",
            } },
            { type: "input.requested", data: { requests: [{
              action: { kind: "tool-call", toolName: proposalToolName, callId: "call", input: {
                proposal: proposalToolName === "create_task"
                  ? { title: "report", dueDate: "2026-08-07", notes: null,
                    proposalId: "original-task-proposal" }
                  : { kind: "timed", title: "Practice", startLocal: "2026-08-03T09:00",
                    endLocal: "2026-08-03T09:30", timeZone: "UTC", recurrence: {
                      frequency: "daily", interval: 1, end: { kind: "count", count: 5 },
                    } },
              } },
              requestId: "approval", prompt: "Approve?",
            }], sequence: 0, stepIndex: 0, turnId: "turn" } },
          );
        }
        if (pendingProposal === "resolved") {
          events.push({ type: "action.result", data: {
            result: { kind: "tool-result", callId: "call", toolName: proposalToolName, output: {} },
            sequence: 0, stepIndex: 0, turnId: "turn", status: "completed",
          } });
        }
        events.push({ type: "turn.completed", data: { sequence: 0, turnId: "turn" } });
        events.push({ type: "session.waiting", data: {
          continuationToken: "token", wait: "next-user-message",
        } });
        const startIndex = options?.startIndex ?? 0;
        const selected = startIndex < 0 ? events.slice(startIndex) : events.slice(startIndex);
        return new ReadableStream({ start(controller) {
          for (const event of selected) controller.enqueue(event);
          controller.close();
        } });
      } } as Session;
    },
  } as unknown as RouteHandlerArgs<TelegramChannelState>;
  for (const body of updates) {
    await route.handler(new Request("https://bud.test/eve/v1/telegram", {
      method: "POST", headers: { "content-type": "application/json",
        "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
      body: JSON.stringify(body),
    }), args);
    await Promise.all(tasks.splice(0));
  }
  return { authContexts, eventStreamStartIndexes, inputResponses, model, outbound,
    replacementProposals };
}

async function deliverWithActiveSession(activeSession: boolean, ...updates: unknown[]) {
  return deliverWithSessionState(
    activeSession, activeSession, "create_calendar_event", vi.fn(async () => false), ...updates,
  );
}

async function deliver(...updates: unknown[]) {
  return deliverWithActiveSession(false, ...updates);
}

describe("Telegram Channel", () => {
  it("downloads and transcribes an Owner voice note before Eve interpretation", async () => {
    const transcription = { transcribe: vi.fn(async () => "What's next today?") };
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 12, file_id: "voice-1", file_size: 1024, mime_type: "audio/ogg",
    }), transcription);

    expect(transcription.transcribe).toHaveBeenCalledWith({
      bytes: expect.any(Uint8Array), fileName: "voice.ogg", mediaType: "audio/ogg",
      model: "test-transcriber",
    });
    expect(result.model).toHaveBeenCalledWith("What's next today?");
    expect(result.outbound).toEqual(["I heard: What's next today?", "Model: What's next today?"]);
  });

  it("makes the transcript visible on a voice-created Proposal before approval", async () => {
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 8, file_id: "voice-2", file_size: 800, mime_type: "audio/ogg",
    }), { transcribe: vi.fn(async () => "Create a task to buy milk") }, { proposal: "task" });

    expect(result.outbound[0]).toBe("I heard: Create a task to buy milk");
    expect(result.model).toHaveBeenCalledWith("Create a task to buy milk");
    expect(result.outbound[1]).toContain("Create Task?\n\nBuy milk\nDue: No due date");
  });

  it("accepts voice notes when Telegram omits optional size and media type", async () => {
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 8, file_id: "voice-optional-metadata",
    }));
    expect(result.model).toHaveBeenCalledWith("What's next today?");
  });

  it("preserves pending-Proposal serialization for transcribed voice input", async () => {
    const correctionClassifier = vi.fn(async () => true);
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 8, file_id: "voice-pending", file_size: 800, mime_type: "audio/ogg",
    }), undefined, { correctionClassifier, pendingProposal: true });
    expect(correctionClassifier).not.toHaveBeenCalled();
    expect(result.model).not.toHaveBeenCalled();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      "I heard: What's next today?",
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
    ]);
  });

  it.each([
    ["too large", { duration: 10, file_id: "voice", file_size: 10 * 1024 * 1024 + 1,
      mime_type: "audio/ogg" }],
    ["too long", { duration: 301, file_id: "voice", file_size: 100, mime_type: "audio/ogg" }],
    ["unsupported format", { duration: 10, file_id: "voice", file_size: 100,
      mime_type: "audio/x-unknown" }],
  ])("rejects a %s voice note before download or interpretation", async (_name, voice) => {
    const result = await deliverMedia(mediaUpdate("voice", voice));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.transcription.transcribe).not.toHaveBeenCalled();
    expect(result.telegramFetch.mock.calls.some(([request]) => String(request).includes("/getFile")))
      .toBe(false);
    expect(result.outbound).toEqual([expect.stringContaining("type your request")]);
  });

  it("turns download or transcription failure into typed-input guidance without Eve", async () => {
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 10, file_id: "voice", file_size: 100, mime_type: "audio/ogg",
    }), { transcribe: vi.fn(async () => { throw new Error("provider failed"); }) });
    expect(result.model).not.toHaveBeenCalled();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([expect.stringContaining("type your request")]);
  });

  it.each([
    ["HTTP failure", () => new Response("unavailable", { status: 503 }), config],
    ["streamed size overflow", () => new Response(new Uint8Array(1025)), {
      ...config, transcriptionMaxBytes: 1024,
    }],
  ] as const)("stops a voice note after %s without Eve", async (_name, response, channelConfig) => {
    const result = await deliverMedia(mediaUpdate("voice", {
      duration: 10, file_id: "voice", file_size: 100, mime_type: "audio/ogg",
    }), undefined, { config: channelConfig, downloadResponse: response });
    expect(result.model).not.toHaveBeenCalled();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.transcription.transcribe).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([expect.stringContaining("type your request")]);
  });

  it.each([
    ["photo", [{ file_id: "photo", file_size: 100, width: 10, height: 10 }]],
    ["document", { file_id: "document", file_size: 100, file_name: "notes.pdf" }],
    ["video", { file_id: "video", file_size: 100, duration: 2 }],
    ["audio", { file_id: "audio", file_size: 100, duration: 2 }],
  ] as const)("rejects unsupported %s without interpretation", async (kind, value) => {
    const result = await deliverMedia(mediaUpdate(kind, value));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.send).not.toHaveBeenCalled();
    expect(result.transcription.transcribe).not.toHaveBeenCalled();
    expect(result.outbound).toEqual(["I can only handle text and Telegram voice notes. Please type your request."]);
  });
  it("shows Event details and conflict warnings in the approval prompt", async () => {
    const post = vi.fn(async () => ({ id: "message-1", raw: null }));
    const state = {} as TelegramChannelState;

    await handleTelegramInputRequested({ requests: [{
      action: {
        callId: "call-1",
        input: { proposal: {
          kind: "timed", title: "Dentist",
          startLocal: "2026-08-02T09:00", endLocal: "2026-08-02T09:30",
          timeZone: "America/New_York", location: "Dental Arts", description: null,
          warnings: [{ kind: "overlap", message: "Overlaps Team sync (Work)" }],
        } },
        kind: "tool-call", toolName: "create_calendar_event",
      },
      allowFreeform: false,
      display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve tool call: create_calendar_event",
      requestId: "approval-1",
    }] } as never, { state, telegram: { post } } as never, {} as never);

    expect(post).toHaveBeenCalledWith({
      reply_markup: { inline_keyboard: [[
        { callback_data: "eve:0", text: "Yes" },
        { callback_data: "eve:1", text: "No" },
      ]] },
      text: [
        "Create Calendar Event?",
        "",
        "Dentist",
        "When: 2026-08-02T09:00–2026-08-02T09:30 (America/New_York)",
        "Location: Dental Arts",
        "",
        "Warning: Overlaps Team sync (Work)",
      ].join("\n"),
    });
  });

  it.each([
    [{ frequency: "daily", interval: 1, end: { kind: "count", count: 5 } },
      "Repeats: Every day; 5 occurrences"],
    [{ frequency: "monthly", interval: 1, end: { kind: "until", date: "2027-01-31" } },
      "Repeats: Every month; through 2027-01-31"],
    [{ frequency: "weekly", interval: 2, weekdays: ["MO", "TH"],
      end: { kind: "count", count: 8 } },
      "Repeats: Every 2 weeks on Monday and Thursday; 8 occurrences"],
  ] as const)("shows recurring Event cadence and boundary in the approval prompt",
    async (recurrence, expected) => {
    const post = vi.fn(async () => ({ id: "message-1", raw: null }));
    await handleTelegramInputRequested({ requests: [{
      action: { callId: "call-1", kind: "tool-call", toolName: "create_calendar_event",
        input: { proposal: { kind: "timed", title: "Practice",
          startLocal: "2026-08-03T09:00", endLocal: "2026-08-03T09:30",
          timeZone: "America/New_York", location: null, description: null, warnings: [],
          recurrence } } },
      allowFreeform: false, display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve?", requestId: "approval-1",
    }] } as never, { state: {} as TelegramChannelState, telegram: { post } } as never, {} as never);

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining(expected),
    }));
  });

  it("shows every warning before offering approval when the Proposal needs multiple messages", async () => {
    const post = vi.fn(async (_message: unknown) => ({ id: "message-1", raw: null }));
    const warnings = Array.from({ length: 80 }, (_, index) => ({
      kind: "overlap",
      message: `Overlaps conflict ${String(index).padStart(2, "0")} (${"Calendar".repeat(10)})`,
    }));

    await handleTelegramInputRequested({ requests: [{
      action: { callId: "call-1", kind: "tool-call", toolName: "create_calendar_event",
        input: { proposal: { kind: "all-day", title: "Retreat",
          startDate: "2026-08-02", throughDate: "2026-08-03", timeZone: "America/New_York",
          location: null, description: null, warnings } } },
      allowFreeform: false, display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve tool call: create_calendar_event", requestId: "approval-1",
    }] } as never, { state: {} as TelegramChannelState, telegram: { post } } as never, {} as never);

    expect(post.mock.calls.length).toBeGreaterThan(1);
    const messages = post.mock.calls.map(([message]) => message as {
      reply_markup?: unknown; text: string;
    });
    for (const warning of warnings) {
      expect(messages.map(({ text }) => text).join("")).toContain(`Warning: ${warning.message}`);
    }
    expect(messages.slice(0, -1).every((message) => message.reply_markup === undefined)).toBe(true);
    expect(messages.at(-1)?.reply_markup).toBeDefined();
  });

  it.each([
    [{ title: "Buy milk", notes: "Get oat milk", dueDate: "2026-08-03" },
      ["Create Task?", "", "Buy milk", "Due: 2026-08-03", "Notes: Get oat milk"]],
    [{ title: "Call Sam", notes: null, dueDate: null },
      ["Create Task?", "", "Call Sam", "Due: No due date"]],
  ] as const)("shows exactly the dated or undated Task in its approval prompt", async (proposal, lines) => {
    const post = vi.fn(async () => ({ id: "message-1", raw: null }));
    await handleTelegramInputRequested({ requests: [{
      action: { callId: "call-1", input: { proposal }, kind: "tool-call", toolName: "create_task" },
      allowFreeform: false, display: "confirmation",
      options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
      prompt: "Approve tool call: create_task", requestId: "approval-1",
    }] } as never, { state: {} as TelegramChannelState, telegram: { post } } as never, {} as never);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ text: lines.join("\n") }));
  });

  it("routes Calendar language through Eve instead of intercepting it", async () => {
    const result = await deliver(update(42, "What's on my calendar Thursday?"));
    expect(result.model).toHaveBeenCalledWith("What's on my calendar Thursday?");
    expect(result.outbound).toEqual(["Model: What's on my calendar Thursday?"]);
  });

  it("routes ordinary Owner messages through Eve", async () => {
    const result = await deliver(update(42, "What is next?"));
    expect(result.model).toHaveBeenCalledOnce();
    expect(result.outbound).toEqual(["Model: What is next?"]);
  });

  it("authenticates an Owner's native approval callback", async () => {
    const result = await deliver(callbackUpdate(42, "eve:0"));
    expect(result.authContexts).toEqual([
      expect.objectContaining({ principalId: "telegram:42" }),
    ]);
  });

  it("does not authenticate another sender's native approval callback", async () => {
    const result = await deliver(callbackUpdate(99, "eve:0"));
    expect(result.authContexts).toEqual([null]);
  });

  it("cancels a pending recurring Event Proposal without starting another model turn", async () => {
    const result = await deliverWithActiveSession(true, callbackUpdate(42, "eve:1"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.inputResponses).toEqual([{
      optionId: "selected", requestId: "telegram_callback:eve:1",
    }]);
  });

  it.each([[99, "private"], [42, "group"]] as const)(
    "drops unauthorized sender/chat %#", async (sender, type) => {
      const result = await deliver(update(sender, "Hello", type));
      expect(result.model).not.toHaveBeenCalled();
      expect(result.outbound).toEqual([]);
    },
  );

  it("resets without sending the command to Eve", async () => {
    const result = await deliver(update(42, "/reset"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual(["Conversation reset."]);
  });

  it("resets an active conversation through Eve's pending-input path", async () => {
    const result = await deliverWithActiveSession(true, update(42, "/reset"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual(["Conversation reset."]);
  });

  it("refuses an unrelated Calendar query while a Proposal approval is pending", async () => {
    const result = await deliverWithActiveSession(true, update(42, "What's on my calendar today?"));
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
    ]);
  });

  it("supersedes a pending Task Proposal before starting a title correction turn", async () => {
    const correctionClassifier = vi.fn(async () => true);
    const result = await deliverWithSessionState(
      true, true, "create_task", correctionClassifier,
      update(42, 'Actually the title should be "due tomorrow report"'),
    );

    expect(correctionClassifier).toHaveBeenCalledWith({
      message: 'Actually the title should be "due tomorrow report"',
      proposal: expect.objectContaining({ title: "report", dueDate: "2026-08-07" }),
      proposalType: "task",
    });
    expect(result.inputResponses).toEqual([{ optionId: "deny", requestId: "approval" }]);
    expect(result.model).toHaveBeenCalledWith('Actually the title should be "due tomorrow report"');
    expect(result.replacementProposals).toEqual([expect.objectContaining({
      title: "due tomorrow report", dueDate: null,
    })]);
    expect(result.outbound.at(-1)).toContain(
      "Create Task?\n\ndue tomorrow report\nDue: No due date",
    );
  });

  it("supersedes a pending Event Proposal before starting a time correction turn", async () => {
    const result = await deliverWithSessionState(
      true, true, "create_calendar_event", vi.fn(async () => true), update(42, "Wait, make that 1pm"),
    );

    expect(result.inputResponses).toEqual([{ optionId: "deny", requestId: "approval" }]);
    expect(result.model).toHaveBeenCalledWith("Wait, make that 1pm");
    expect(result.replacementProposals).toEqual([expect.objectContaining({
      startLocal: "2026-08-03T13:00",
    })]);
    expect(result.outbound.at(-1)).toContain("2026-08-03T13:00–2026-08-03T13:30");
  });

  it("finds the current Proposal from a bounded tail after historical waiting events", async () => {
    const result = await deliverWithActiveSession(
      true,
      update(42, "What is the weather?"),
      update(42, "And tomorrow?"),
    );
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
    ]);
    expect(result.inputResponses).toEqual([]);
    expect(result.eventStreamStartIndexes).toEqual([-3, -3]);
  });

  it("does not label an ordinary active turn as a pending Proposal", async () => {
    const result = await deliverWithSessionState(
      true, false, "create_calendar_event", vi.fn(async () => false), update(42, "One more detail"),
    );
    expect(result.model).toHaveBeenCalledWith("One more detail");
    expect(result.outbound).toEqual(["Model: One more detail"]);
  });

  it("does not treat a resolved Event approval in history as pending", async () => {
    const result = await deliverWithSessionState(
      true, "resolved", "create_calendar_event", vi.fn(async () => false), update(42, "Thanks"),
    );
    expect(result.model).toHaveBeenCalledWith("Thanks");
    expect(result.outbound).toEqual(["Model: Thanks"]);
  });

  it("refuses unrelated text while a Task Proposal is pending", async () => {
    const result = await deliverWithSessionState(
      true, true, "create_task", vi.fn(async () => false), update(42, "What is the weather?"),
    );
    expect(result.model).not.toHaveBeenCalled();
    expect(result.outbound).toEqual([
      "Please approve or deny the pending proposal before starting another request. You can also use /reset.",
    ]);
  });

  it("allows a new request after a Task Proposal is denied or approved", async () => {
    const result = await deliverWithSessionState(
      true, "resolved", "create_task", vi.fn(async () => false), update(42, "Thanks"),
    );
    expect(result.model).toHaveBeenCalledWith("Thanks");
  });
});
