import { createCreateCalendarEventTool } from "../lib/calendar-tool.js";
import { calendarConfig, configuredCalendarAdapter } from "../lib/configured-calendar.js";

export default createCreateCalendarEventTool({
  adapter: configuredCalendarAdapter,
  ownerId: calendarConfig.ownerId,
});
