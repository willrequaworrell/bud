import { loadConfig } from "../lib/config.js";
import { createBudTelegramChannel } from "../lib/telegram-channel.js";

const config = loadConfig();

export default createBudTelegramChannel(config);
