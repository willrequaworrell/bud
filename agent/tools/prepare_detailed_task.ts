import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createPrepareDetailedTaskTool } from "../lib/tasks-tool.js";

export default createPrepareDetailedTaskTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
});
