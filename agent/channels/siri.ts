import telegram from "./telegram.js";
import { loadConfig } from "../lib/config.js";
import { createSiriCaptureChannel } from "../lib/siri-capture-channel.js";

const config = loadConfig();

export default createSiriCaptureChannel(config, telegram);
