import { createPrepareCalendarEventTool } from "../lib/calendar-tool.js";
import { calendarConfig, configuredCalendarAdapter } from "../lib/configured-calendar.js";

export default createPrepareCalendarEventTool({
  adapter: configuredCalendarAdapter,
  ownerId: calendarConfig.ownerId,
});
