import {
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  sendTelegramMessage,
  telegramChannel,
  type TelegramChannel,
  type TelegramChannelEvents,
  type TelegramChannelState,
  type TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs, Session } from "eve/channels";

import type { BudConfig } from "./config.js";
import { isOwnerPrivateText } from "./telegram-policy.js";

const RESET_REQUEST_PREFIX = "bud:conversation-reset:";
const REFUSED_REQUEST_PREFIX = "bud:pending-proposal-refused:";
const PENDING_PROPOSAL_MESSAGE =
  "Please approve or deny the pending proposal before starting another request. You can also use /reset.";

interface ResettableTelegramChannel {
  adapter: {
    createAdapterContext(ctx: ResetAdapterContext): {
      telegram: { sendMessage(message: string): Promise<unknown> };
    };
    deliver(payload: ResetPayload, ctx: ResetAdapterContext): unknown;
  };
  routes: Array<{
    handler(request: Request, args: RouteHandlerArgs<TelegramChannelState>): Promise<Response>;
    transport: string;
  }>;
}

interface ResetAdapterContext {
  ctx: object;
  session: {
    continuationToken: string;
    setContinuationToken(token: string): void;
  };
  state: TelegramChannelState;
}

interface ResetPayload {
  inputResponses?: ReadonlyArray<{ requestId: string }>;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function eventProposalApprovalPrompt(input: unknown): string | undefined {
  const proposal = record(record(input)?.proposal);
  if (!proposal || typeof proposal.title !== "string" ||
      typeof proposal.kind !== "string" || typeof proposal.timeZone !== "string") return undefined;

  let when: string;
  if (proposal.kind === "timed" && typeof proposal.startLocal === "string" &&
      typeof proposal.endLocal === "string") {
    when = `${proposal.startLocal}–${proposal.endLocal} (${proposal.timeZone})`;
  } else if (proposal.kind === "all-day" && typeof proposal.startDate === "string" &&
      typeof proposal.throughDate === "string") {
    when = proposal.startDate === proposal.throughDate
      ? `${proposal.startDate} (all day; ${proposal.timeZone})`
      : `${proposal.startDate}–${proposal.throughDate} (all day; ${proposal.timeZone})`;
  } else {
    return undefined;
  }

  const details = [proposal.title, `When: ${when}`];
  const recurrence = record(proposal.recurrence);
  const recurrenceEnd = record(recurrence?.end);
  if (recurrence && recurrenceEnd && typeof recurrence.frequency === "string" &&
      typeof recurrence.interval === "number") {
    const weekdays = Array.isArray(recurrence.weekdays)
      ? recurrence.weekdays.filter((day): day is string => typeof day === "string") : [];
    const weekdayNames: Record<string, string> = {
      MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday",
      FR: "Friday", SA: "Saturday", SU: "Sunday",
    };
    const cadence = recurrence.interval === 1
      ? `Every ${{ daily: "day", weekly: "week", monthly: "month" }[recurrence.frequency] ?? recurrence.frequency}`
      : `Every ${recurrence.interval} ${recurrence.frequency === "daily" ? "days" :
          recurrence.frequency === "weekly" ? "weeks" : "months"}`;
    const onDays = weekdays.length
      ? ` on ${weekdays.map((day) => weekdayNames[day] ?? day).join(weekdays.length === 2 ? " and " : ", ")}`
      : "";
    const boundary = recurrenceEnd.kind === "count" && typeof recurrenceEnd.count === "number"
      ? `${recurrenceEnd.count} occurrences`
      : recurrenceEnd.kind === "until" && typeof recurrenceEnd.date === "string"
        ? `through ${recurrenceEnd.date}` : undefined;
    if (boundary) details.push(`Repeats: ${cadence}${onDays}; ${boundary}`);
  }
  if (typeof proposal.location === "string") details.push(`Location: ${proposal.location}`);
  if (typeof proposal.description === "string") details.push(`Description: ${proposal.description}`);
  const warnings = Array.isArray(proposal.warnings)
    ? proposal.warnings.flatMap((warning) => {
        const message = record(warning)?.message;
        return typeof message === "string" ? [`Warning: ${message}`] : [];
      })
    : [];
  return ["Create Calendar Event?", "", ...details, ...(warnings.length ? ["", ...warnings] : [])]
    .join("\n");
}

function taskProposalApprovalPrompt(input: unknown): string | undefined {
  const proposal = record(record(input)?.proposal);
  if (!proposal || typeof proposal.title !== "string" ||
      !(proposal.dueDate === null || typeof proposal.dueDate === "string") ||
      !(proposal.notes === null || typeof proposal.notes === "string")) return undefined;
  return [
    "Create Task?", "", proposal.title,
    `Due: ${proposal.dueDate ?? "No due date"}`,
    ...(proposal.notes ? [`Notes: ${proposal.notes}`] : []),
  ].join("\n");
}

function proposalApprovalPrompt(toolName: string, input: unknown) {
  if (toolName.endsWith("create_calendar_event")) return eventProposalApprovalPrompt(input);
  if (toolName.endsWith("create_task")) return taskProposalApprovalPrompt(input);
  return undefined;
}

function isProposalCreationTool(toolName: string) {
  return toolName.endsWith("create_calendar_event") || toolName.endsWith("create_task");
}

function approvalPromptChunks(prompt: string): string[] {
  const characters = Array.from(prompt);
  const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += 3_500) {
    chunks.push(characters.slice(start, start + 3_500).join(""));
  }
  return chunks.length ? chunks : [""];
}

export const handleTelegramInputRequested: NonNullable<
  TelegramChannelEvents["input.requested"]
> = async (data, channel) => {
  for (const request of data.requests) {
    const prompt = proposalApprovalPrompt(request.action.toolName, request.action.input);
    const chunks = prompt ? approvalPromptChunks(prompt) : [request.prompt];
    for (const chunk of chunks.slice(0, -1)) {
      await channel.telegram.post({ text: chunk });
    }
    const rendered = renderTelegramInputRequest(
      { ...request, prompt: chunks.at(-1)! },
      channel.state,
    );
    const message = await channel.telegram.post({
      ...(rendered.replyMarkup ? { reply_markup: rendered.replyMarkup } : {}),
      text: rendered.text,
    });
    if (rendered.freeformRequestId !== undefined && message.id) {
      registerTelegramFreeformPrompt(channel.state, {
        messageId: message.id,
        requestId: rendered.freeformRequestId,
      });
    }
  }
};

function completedSyntheticSession(requestId: string): Session {
  return {
    id: requestId,
    continuationToken: requestId,
    async cancel() {
      return { status: "no_active_turn" };
    },
    async getEventStream() {
      return new ReadableStream();
    },
  };
}

async function hasPendingProposal(args: RouteHandlerArgs<TelegramChannelState>, sessionId: string) {
  const stream = await args.getSession(sessionId).getEventStream({ startIndex: 0 });
  const reader = stream.getReader();
  const pendingCallIds = new Set<string>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return pendingCallIds.size > 0;
      if (value.type === "input.requested") {
        for (const request of value.data.requests) {
          if (isProposalCreationTool(request.action.toolName)) {
            pendingCallIds.add(request.action.callId);
          }
        }
      } else if (value.type === "action.result") {
        pendingCallIds.delete(value.data.result.callId);
      } else if (value.type === "session.waiting") {
        return pendingCallIds.size > 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function ownerAuth(message: TelegramMessage) {
  const user = message.from!;
  return {
    attributes: {
      chat_id: message.chat.id,
      chat_type: message.chat.type,
      message_id: message.messageId,
      user_id: user.id,
    },
    authenticator: "telegram-webhook",
    issuer: "telegram",
    principalId: `telegram:${user.id}`,
    principalType: "user",
  } as const;
}

function ownerCallbackAuth(state: TelegramChannelState, ownerId: string) {
  if (!state.chatId || state.chatType !== "private" || state.triggeringUserId !== ownerId) return null;
  return {
    attributes: {
      chat_id: state.chatId,
      chat_type: state.chatType,
      user_id: state.triggeringUserId,
    },
    authenticator: "telegram-webhook",
    issuer: "telegram",
    principalId: `telegram:${ownerId}`,
    principalType: "user",
  } as const;
}

export function createBudTelegramChannel(
  channelConfig: BudConfig,
  telegramFetch?: typeof fetch,
): TelegramChannel {
  const channel = telegramChannel({
    ...(telegramFetch ? { api: { fetch: telegramFetch } } : {}),
    credentials: {
      botToken: channelConfig.telegramBotToken,
      webhookSecretToken: channelConfig.telegramWebhookSecret,
    },
    events: { "input.requested": handleTelegramInputRequested },
    async onMessage(ctx, message) {
      if (!isOwnerPrivateText(message, channelConfig.ownerId)) {
        return null;
      }

      await ctx.telegram.startTyping();
      return { auth: ownerAuth(message) };
    },
  });
  const compiled = channel as typeof channel & ResettableTelegramChannel;

  const deliver = compiled.adapter.deliver.bind(compiled.adapter);
  compiled.adapter.deliver = async (payload, ctx) => {
    const resetRequestId = payload.inputResponses?.[0]?.requestId;
    if (resetRequestId?.startsWith(RESET_REQUEST_PREFIX)) {
      ctx.session.setContinuationToken(`reset:${crypto.randomUUID()}`);
      const telegram = compiled.adapter.createAdapterContext(ctx).telegram;
      await telegram.sendMessage("Conversation reset.");
      return;
    }
    return deliver(payload, ctx);
  };

  const route = compiled.routes[0];
  if (route?.transport !== "http") throw new Error("Telegram route is missing");
  const handleTelegramRequest = route.handler;
  route.handler = (request, args) =>
    handleTelegramRequest(request, {
      ...args,
      async send(input, options) {
        const message =
          typeof input === "object" && !Array.isArray(input) && "message" in input
            ? input.message
            : input;
        if (message !== "/reset") {
          if (typeof message !== "string") {
            const auth = options.auth ?? ownerCallbackAuth(options.state, channelConfig.ownerId);
            return args.send(input, { ...options, auth });
          }
          const active = await args.resolveActiveSession({
            continuationToken: options.continuationToken,
          });
          if (!active || !await hasPendingProposal(args, active.sessionId)) {
            return args.send(input, options);
          }
          await sendTelegramMessage({
            ...(telegramFetch ? { fetch: telegramFetch } : {}),
            body: { text: PENDING_PROPOSAL_MESSAGE },
            chatId: options.state.chatId!,
            credentials: { botToken: channelConfig.telegramBotToken },
          });
          return completedSyntheticSession(`${REFUSED_REQUEST_PREFIX}${crypto.randomUUID()}`);
        }

        const active = await args.resolveActiveSession({
          continuationToken: options.continuationToken,
        });
        const resetRequestId = `${RESET_REQUEST_PREFIX}${crypto.randomUUID()}`;
        if (!active) {
          await sendTelegramMessage({
            ...(telegramFetch ? { fetch: telegramFetch } : {}),
            body: { text: "Conversation reset." },
            chatId: options.state.chatId!,
            credentials: { botToken: channelConfig.telegramBotToken },
          });
          return completedSyntheticSession(resetRequestId);
        }

        return args.send(
          { inputResponses: [{ requestId: resetRequestId }] },
          options,
        );
      },
    });

  return channel;
}
