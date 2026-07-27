export interface BudConfig {
  assistantName: string;
  modelId: string;
  ownerId: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_ASSISTANT_NAME = "Bud";
const DEFAULT_MODEL_ID = "openai/gpt-5.4-mini";

export function loadConfig(environment: Environment = process.env): BudConfig {
  const errors: string[] = [];
  const ownerId = environment.TELEGRAM_OWNER_ID?.trim();
  const telegramBotToken = environment.TELEGRAM_BOT_TOKEN?.trim();
  const telegramWebhookSecret =
    environment.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim();

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
    modelId: environment.BUD_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    ownerId: ownerId!,
    telegramBotToken: telegramBotToken!,
    telegramWebhookSecret: telegramWebhookSecret!,
  };
}
