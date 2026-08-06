import { loadConfig } from "../lib/config.js";
import { createBudTelegramChannel } from "../lib/telegram-channel.js";
import { createOpenAITranscriptionAdapter } from "../lib/transcription.js";
import { createProposalCorrectionClassifier } from "../lib/proposal-correction.js";

const config = loadConfig();

export default createBudTelegramChannel(config, {
  correctionClassifier: createProposalCorrectionClassifier(config.modelId),
  transcription: createOpenAITranscriptionAdapter(),
});
