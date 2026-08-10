import { loadConfig } from "../lib/config.js";
import { createBudTelegramChannel } from "../lib/telegram-channel.js";
import { createOpenAITranscriptionAdapter } from "../lib/transcription.js";
import { createPreparedWriteCorrectionClassifier } from "../lib/prepared-write-correction.js";

const config = loadConfig();

export default createBudTelegramChannel(config, {
  correctionClassifier: createPreparedWriteCorrectionClassifier(config.modelId),
  transcription: createOpenAITranscriptionAdapter(),
});
