export interface Task {
  dueDate?: string;
  title: string;
}

export interface TasksPage {
  tasks: readonly Task[];
  truncated: boolean;
}

export type TasksFailure = "access_revoked" | "authentication_expired" | "rate_limited" | "unavailable";

export class TasksAdapterError extends Error {
  constructor(readonly failure: TasksFailure) {
    super(failure);
    this.name = "TasksAdapterError";
  }
}

export interface TasksAdapter {
  listIncomplete(limit: number): Promise<TasksPage>;
}

export function groupTasks(tasks: readonly Task[], today: string) {
  const overdue: Task[] = [];
  const upcoming: Task[] = [];
  const undated: Task[] = [];
  for (const task of tasks) {
    if (!task.dueDate) undated.push(task);
    else if (task.dueDate < today) overdue.push(task);
    else upcoming.push(task);
  }
  return { overdue, upcoming, undated };
}
