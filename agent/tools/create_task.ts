import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createCreateTaskTool } from "../lib/tasks-tool.js";

export default createCreateTaskTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
});
