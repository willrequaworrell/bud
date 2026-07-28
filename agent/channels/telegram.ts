import { loadConfig } from "../lib/config.js";
import { createBudTelegramChannel } from "../lib/telegram-channel.js";
import { createConfiguredGoogleOrganizer } from "../lib/google-calendar.js";

const config = loadConfig();

export default createBudTelegramChannel(config, undefined, {
  organizer: createConfiguredGoogleOrganizer(config),
});
