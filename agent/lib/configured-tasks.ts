import { loadConfig } from "./config.js";
import { createGoogleTasksAdapter } from "./google-tasks.js";
import { createGoogleTokenProvider } from "./google-token-provider.js";

export const tasksConfig = loadConfig();

export const configuredTasksAdapter = createGoogleTasksAdapter({
  listId: tasksConfig.googleTasksListId,
  tokenProvider: createGoogleTokenProvider({
    clientId: tasksConfig.googleOAuthClientId,
    clientSecret: tasksConfig.googleOAuthClientSecret,
    refreshToken: tasksConfig.googleOAuthRefreshToken,
  }),
});
