import { loadConfig } from "./config.js";
import { createConfiguredGoogleCalendarAdapter } from "./google-calendar.js";

export const calendarConfig = loadConfig();
export const configuredCalendarAdapter = createConfiguredGoogleCalendarAdapter(calendarConfig);

let cachedTimeZone: Promise<string> | undefined;

export function getConfiguredCalendarTimeZone(): Promise<string> {
  cachedTimeZone ??= configuredCalendarAdapter.getDefaultTimeZone().catch((error) => {
    cachedTimeZone = undefined;
    throw error;
  });
  return cachedTimeZone;
}
