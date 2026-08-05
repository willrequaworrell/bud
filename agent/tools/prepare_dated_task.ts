import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { createPrepareDatedTaskTool } from "../lib/tasks-tool.js";

export default createPrepareDatedTaskTool({
  adapter: configuredTasksAdapter,
  ownerId: tasksConfig.ownerId,
});
