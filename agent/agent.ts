import { defineAgent } from "eve";

import { loadConfig } from "./lib/config.js";

const config = loadConfig();

export default defineAgent({
  model: config.modelId,
});
