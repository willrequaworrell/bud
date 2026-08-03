import {
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramMessage,
} from "eve/channels/telegram";

import type { BudConfig } from "./config.js";
import type { TranscriptionAdapter } from "./transcription.js";

const UNSUPPORTED_MEDIA_MESSAGE =
  "I can only handle text and Telegram voice notes. Please type your request.";
const VOICE_FAILURE_MESSAGE =
  "I couldn't process that voice note. Please type your request.";
const VOICE_MEDIA_TYPES = new Set(["application/ogg", "audio/ogg", "audio/opus"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Voice download failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Voice download exceeded configured size");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Voice download exceeded configured size");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function ownerPrivateRawMessage(update: unknown, ownerId: string) {
  const message = record(record(update)?.message);
  const chat = record(message?.chat);
  const from = record(message?.from);
  return message && chat?.type === "private" && String(from?.id) === ownerId ? message : undefined;
}

function hasUnsupportedMedia(message: Record<string, unknown>) {
  return ["animation", "audio", "document", "photo", "sticker", "video", "video_note"]
    .some((field) => message[field] !== undefined);
}

export interface TelegramMediaDependencies {
  telegramFetch?: typeof fetch;
  transcription?: TranscriptionAdapter;
}

export async function preprocessTelegramMedia(
  request: Request,
  config: BudConfig,
  dependencies: TelegramMediaDependencies,
): Promise<Request | Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== config.telegramWebhookSecret) {
    return request;
  }
  const update = await request.clone().json().catch(() => undefined);
  const message = ownerPrivateRawMessage(update, config.ownerId);
  const voice = record(message?.voice);
  if (!message || (!voice && !hasUnsupportedMedia(message))) return request;

  const sendResponse = (text: string) => sendTelegramMessage({
    ...(dependencies.telegramFetch ? { fetch: dependencies.telegramFetch } : {}),
    body: { text }, chatId: String(record(message.chat)?.id),
    credentials: { botToken: config.telegramBotToken },
  });
  if (!voice) {
    await sendResponse(UNSUPPORTED_MEDIA_MESSAGE);
    return new Response("ok");
  }

  const duration = voice.duration;
  const fileId = voice.file_id;
  const size = voice.file_size;
  const suppliedMediaType = voice.mime_type;
  const mediaType = typeof suppliedMediaType === "string" ? suppliedMediaType : "audio/ogg";
  const invalidSize = size !== undefined &&
    (typeof size !== "number" || !Number.isInteger(size) || size < 1 ||
      size > config.transcriptionMaxBytes);
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 ||
      duration > config.transcriptionMaxDurationSeconds || typeof fileId !== "string" ||
      invalidSize || !VOICE_MEDIA_TYPES.has(mediaType) || !dependencies.transcription) {
    await sendResponse(VOICE_FAILURE_MESSAGE);
    return new Response("ok");
  }

  try {
    const file = await getTelegramFile({
      ...(dependencies.telegramFetch ? { fetch: dependencies.telegramFetch } : {}), fileId,
      credentials: { botToken: config.telegramBotToken },
    });
    const download = await downloadTelegramFile({
      ...(dependencies.telegramFetch ? { fetch: dependencies.telegramFetch } : {}),
      filePath: file.filePath, credentials: { botToken: config.telegramBotToken },
    });
    const bytes = await responseBytes(download, config.transcriptionMaxBytes);
    if (bytes.byteLength === 0) throw new Error("Voice download was empty");
    const transcript = (await dependencies.transcription.transcribe({
      bytes, fileName: "voice.ogg", mediaType, model: config.transcriptionModel,
    })).trim();
    if (!transcript) throw new Error("Transcription was empty");
    await sendResponse(`I heard: ${transcript}`);
    const decoded = record(update)!;
    return new Request(request, {
      body: JSON.stringify({ ...decoded, message: { ...message, text: transcript, voice: undefined } }),
    });
  } catch {
    await sendResponse(VOICE_FAILURE_MESSAGE);
    return new Response("ok");
  }
}
