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
import { parseApprovalRequest, renderApprovalRequest } from "./approval-request.js";
import { isOwnerPrivateText } from "./telegram-policy.js";
import { preprocessTelegramMedia, type TelegramMediaDependencies } from "./telegram-media.js";
import type { PreparedWriteCorrectionClassifier } from "./prepared-write-correction.js";

const RESET_REQUEST_PREFIX = "bud:conversation-reset:";
const REFUSED_REQUEST_PREFIX = "bud:pending-approval-request-refused:";
const PENDING_APPROVAL_REQUEST_MESSAGE =
  "Please approve or deny the pending Approval Request before starting another request. You can also use /reset.";
const PARKED_SESSION_TAIL_SIZE = 3;

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

interface TelegramChannelDependencies extends TelegramMediaDependencies {
  correctionClassifier?: PreparedWriteCorrectionClassifier;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function isTelegramFreeTextRequest(request: Request): Promise<boolean> {
  const update = record(await request.clone().json().catch(() => undefined));
  const message = record(update?.message);
  return typeof message?.text === "string" && message.text.trim().length > 0;
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
    const prompt = renderApprovalRequest({
      input: request.action.input,
      toolName: request.action.toolName,
    });
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

interface PendingApprovalRequest {
  preparedWrite: Record<string, unknown>;
  preparedWriteType: "event" | "task";
  requestId: string;
}

async function pendingApprovalRequest(
  args: RouteHandlerArgs<TelegramChannelState>,
  sessionId: string,
): Promise<PendingApprovalRequest | undefined> {
  const stream = await args.getSession(sessionId).getEventStream({
    startIndex: -PARKED_SESSION_TAIL_SIZE,
  });
  const reader = stream.getReader();
  const pendingCallIds = new Set<string>();
  const approvalRequestsByCallId = new Map<string, PendingApprovalRequest>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      if (value.type === "input.requested") {
        for (const request of value.data.requests) {
          const approvalRequest = parseApprovalRequest({
            input: request.action.input,
            toolName: request.action.toolName,
          });
          if (approvalRequest) {
            pendingCallIds.add(request.action.callId);
            approvalRequestsByCallId.set(request.action.callId, {
              preparedWrite: approvalRequest.preparedWrite,
              preparedWriteType: approvalRequest.preparedWriteType,
              requestId: request.requestId,
            });
          }
        }
      } else if (value.type === "action.result") {
        pendingCallIds.delete(value.data.result.callId);
        approvalRequestsByCallId.delete(value.data.result.callId);
      } else if (value.type === "session.waiting") {
        const pendingCallId = pendingCallIds.values().next().value;
        return pendingCallId ? approvalRequestsByCallId.get(pendingCallId) : undefined;
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
  dependencies: TelegramChannelDependencies = {},
): TelegramChannel {
  const { correctionClassifier, telegramFetch } = dependencies;
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
  route.handler = async (request, args) => {
    const isFreeText = await isTelegramFreeTextRequest(request);
    const processedRequest = await preprocessTelegramMedia(request, channelConfig, dependencies);
    if (processedRequest instanceof Response) return processedRequest;
    return handleTelegramRequest(processedRequest, {
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
          const pending = active ? await pendingApprovalRequest(args, active.sessionId) : undefined;
          if (!pending) {
            return args.send(input, options);
          }
          const isCorrection = correctionClassifier && isFreeText
            ? await correctionClassifier({
                message,
                preparedWrite: pending.preparedWrite,
                preparedWriteType: pending.preparedWriteType,
              }).catch(() => false)
            : false;
          if (isCorrection) {
            await args.send(
              { inputResponses: [{ optionId: "deny", requestId: pending.requestId }] },
              options,
            );
            return args.send(input, options);
          }
          await sendTelegramMessage({
            ...(telegramFetch ? { fetch: telegramFetch } : {}),
            body: { text: PENDING_APPROVAL_REQUEST_MESSAGE },
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
  };

  return channel;
}
