import { loadConfig } from "./config.js";
import { createUpstashCreationGuard } from "./creation-guard.js";

const config = loadConfig();

export const configuredCreationGuard = createUpstashCreationGuard({
  ...(config.upstashRedis ? config.upstashRedis : {}),
});
