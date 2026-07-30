import { createListCalendarEventsTool } from "../lib/calendar-tool.js";
import { calendarConfig, configuredCalendarAdapter } from "../lib/configured-calendar.js";

export default createListCalendarEventsTool({
  adapter: configuredCalendarAdapter,
  ownerId: calendarConfig.ownerId,
});
