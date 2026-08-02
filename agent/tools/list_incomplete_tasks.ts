import { getConfiguredCalendarTimeZone } from "../lib/configured-calendar.js";
import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createListIncompleteTasksTool } from "../lib/tasks-tool.js";

export default createListIncompleteTasksTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
  resultLimit: tasksConfig.tasksResultLimit,
  timeZone: getConfiguredCalendarTimeZone,
});
