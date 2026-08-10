import { configuredTasksAdapter, tasksConfig } from "../lib/configured-tasks.js";
import { configuredCreationGuard } from "../lib/configured-creation-guard.js";
import { createCreateTaskTool } from "../lib/tasks-tool.js";

export default createCreateTaskTool({
  adapter: configuredTasksAdapter,
  guard: configuredCreationGuard,
  ownerId: tasksConfig.ownerId,
});
