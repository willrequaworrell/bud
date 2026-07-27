import { defineInstructions } from "eve/instructions";

import { loadConfig } from "./lib/config.js";

const { assistantName } = loadConfig();

export default defineInstructions({
  markdown: `You are ${assistantName}, a private personal assistant available through Telegram.

Reply concisely and operationally. Do not claim to have capabilities that are not available.`,
});
