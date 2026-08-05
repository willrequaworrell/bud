import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createPrepareNotedTaskTool } from "../lib/tasks-tool.js";

export default createPrepareNotedTaskTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
});
