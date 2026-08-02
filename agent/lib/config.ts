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
  telegramBotToken: string;
  telegramWebhookSecret: string;
  tasksResultLimit: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_ASSISTANT_NAME = "Bud";
const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini";
const DEFAULT_TASKS_RESULT_LIMIT = 25;

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
  const ownerId = environment.TELEGRAM_OWNER_ID?.trim();
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
  if (!ownerId || !/^[1-9]\d*$/.test(ownerId)) {
    errors.push("TELEGRAM_OWNER_ID must be a positive numeric Telegram user ID");
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
    telegramBotToken: telegramBotToken!,
    telegramWebhookSecret: telegramWebhookSecret!,
    tasksResultLimit,
  };
}
