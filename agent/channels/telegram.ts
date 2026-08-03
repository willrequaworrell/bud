import { loadConfig } from "../lib/config.js";
import { createBudTelegramChannel } from "../lib/telegram-channel.js";
import { createOpenAITranscriptionAdapter } from "../lib/transcription.js";

const config = loadConfig();

export default createBudTelegramChannel(config, {
  transcription: createOpenAITranscriptionAdapter(),
});
