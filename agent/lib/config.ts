export interface BudConfig {
  assistantName: string;
  googleCalendarId: string;
  googleCalendarReadIds: readonly string[];
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOAuthRefreshToken: string;
  googleTasksListId: string;
  modelId: string;
  ownerId: string;
  siriCaptureToken?: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  tasksResultLimit: number;
  transcriptionMaxBytes: number;
  transcriptionMaxDurationSeconds: number;
  transcriptionModel: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_ASSISTANT_NAME = "Bud";
const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini";
const DEFAULT_TASKS_RESULT_LIMIT = 25;
const DEFAULT_TRANSCRIPTION_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TRANSCRIPTION_MAX_DURATION_SECONDS = 5 * 60;
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export function loadConfig(environment: Environment = process.env): BudConfig {
  const errors: string[] = [];
  const googleOAuthClientId = environment.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const googleOAuthClientSecret = environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const googleOAuthRefreshToken = environment.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  const googleCalendarId = environment.GOOGLE_CALENDAR_ID?.trim() || "primary";
  const googleCalendarReadIds = environment.GOOGLE_CALENDAR_READ_IDS === undefined
    ? [googleCalendarId]
    : [...new Set(
      environment.GOOGLE_CALENDAR_READ_IDS
        .split(",")
        .map((calendarId) => calendarId.trim())
        .filter(Boolean),
    )];
  const googleTasksListId = environment.GOOGLE_TASKS_LIST_ID?.trim() || "@default";
  const tasksResultLimit = environment.GOOGLE_TASKS_RESULT_LIMIT === undefined
    ? DEFAULT_TASKS_RESULT_LIMIT
    : Number(environment.GOOGLE_TASKS_RESULT_LIMIT);
  const transcriptionMaxBytes = environment.TELEGRAM_VOICE_MAX_BYTES === undefined
    ? DEFAULT_TRANSCRIPTION_MAX_BYTES : Number(environment.TELEGRAM_VOICE_MAX_BYTES);
  const transcriptionMaxDurationSeconds =
    environment.TELEGRAM_VOICE_MAX_DURATION_SECONDS === undefined
      ? DEFAULT_TRANSCRIPTION_MAX_DURATION_SECONDS
      : Number(environment.TELEGRAM_VOICE_MAX_DURATION_SECONDS);
  const ownerId = environment.TELEGRAM_OWNER_ID?.trim();
  const siriCaptureToken = environment.BUD_SIRI_CAPTURE_TOKEN?.trim() || undefined;
  const telegramBotToken = environment.TELEGRAM_BOT_TOKEN?.trim();
  const telegramWebhookSecret =
    environment.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim();

  if (!googleOAuthClientId) errors.push("GOOGLE_OAUTH_CLIENT_ID is required");
  if (!googleOAuthClientSecret) errors.push("GOOGLE_OAUTH_CLIENT_SECRET is required");
  if (!googleOAuthRefreshToken) errors.push("GOOGLE_OAUTH_REFRESH_TOKEN is required");
  if (googleCalendarReadIds.length === 0) {
    errors.push("GOOGLE_CALENDAR_READ_IDS must contain at least one calendar");
  }
  if (googleCalendarReadIds.length > 10) {
    errors.push("GOOGLE_CALENDAR_READ_IDS supports at most 10 calendars");
  }
  if (!Number.isInteger(tasksResultLimit) || tasksResultLimit < 1 || tasksResultLimit > 100) {
    errors.push("GOOGLE_TASKS_RESULT_LIMIT must be an integer from 1 to 100");
  }
  if (!Number.isInteger(transcriptionMaxBytes) || transcriptionMaxBytes < 1) {
    errors.push("TELEGRAM_VOICE_MAX_BYTES must be a positive integer");
  }
  if (!Number.isInteger(transcriptionMaxDurationSeconds) || transcriptionMaxDurationSeconds < 1) {
    errors.push("TELEGRAM_VOICE_MAX_DURATION_SECONDS must be a positive integer");
  }
  if (!ownerId || !/^[1-9]\d*$/.test(ownerId)) {
    errors.push("TELEGRAM_OWNER_ID must be a positive numeric Telegram user ID");
  }
  if (siriCaptureToken && siriCaptureToken.length < 32) {
    errors.push("BUD_SIRI_CAPTURE_TOKEN must contain at least 32 characters");
  }
  if (!telegramBotToken) {
    errors.push("TELEGRAM_BOT_TOKEN is required");
  }
  if (!telegramWebhookSecret) {
    errors.push("TELEGRAM_WEBHOOK_SECRET_TOKEN is required");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.join("; ")}`);
  }

  return {
    assistantName:
      environment.BUD_ASSISTANT_NAME?.trim() || DEFAULT_ASSISTANT_NAME,
    googleCalendarId,
    googleCalendarReadIds,
    googleOAuthClientId: googleOAuthClientId!,
    googleOAuthClientSecret: googleOAuthClientSecret!,
    googleOAuthRefreshToken: googleOAuthRefreshToken!,
    googleTasksListId,
    modelId: environment.BUD_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    ownerId: ownerId!,
    ...(siriCaptureToken ? { siriCaptureToken } : {}),
    telegramBotToken: telegramBotToken!,
    telegramWebhookSecret: telegramWebhookSecret!,
    tasksResultLimit,
    transcriptionMaxBytes,
    transcriptionMaxDurationSeconds,
    transcriptionModel: environment.BUD_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
  };
}
