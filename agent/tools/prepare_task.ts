import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createPrepareTaskTool } from "../lib/tasks-tool.js";

export default createPrepareTaskTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
});
