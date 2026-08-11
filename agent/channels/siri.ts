import telegram from "./telegram.js";
import { loadConfig } from "../lib/config.js";
import { createSiriCaptureChannel } from "../lib/siri-capture-channel.js";

export const maxDuration = 15;

const config = loadConfig();

export default createSiriCaptureChannel(config, telegram);
