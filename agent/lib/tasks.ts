import { createHash } from "node:crypto";

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
  createTask?(task: TaskWrite): Promise<{ taskId: string }>;
  listIncomplete(limit: number): Promise<TasksPage>;
}

export interface TaskWrite {
  dueDate: string | null;
  idempotencyKey: string;
  notes: string | null;
  title: string;
}

export interface TaskProposal {
  dueDate: string | null;
  notes: string | null;
  proposalId: string;
  title: string;
}

function proposalIdentity(proposal: Omit<TaskProposal, "proposalId">): string {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

export function isTaskProposalUnchanged(proposal: TaskProposal): boolean {
  const { proposalId, ...details } = proposal;
  return proposalIdentity(details) === proposalId;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const normalized = new Date(Date.UTC(year!, month! - 1, day!));
  return normalized.getUTCFullYear() === year && normalized.getUTCMonth() + 1 === month &&
    normalized.getUTCDate() === day;
}

export function createTasks(adapter: TasksAdapter) {
  return {
    prepareTask(input: { title: string; notes?: string | undefined; dueDate?: string | undefined }) {
      const title = input.title.trim();
      if (!title) return { status: "error" as const, reason: "title_required" as const };
      if (input.dueDate !== undefined && !validDate(input.dueDate)) {
        return { status: "error" as const, reason: "invalid_due_date" as const };
      }
      const details = {
        title,
        notes: input.notes?.trim() || null,
        dueDate: input.dueDate ?? null,
      };
      return { status: "ok" as const, proposal: {
        ...details, proposalId: proposalIdentity(details),
      } };
    },
    async createTask(proposal: TaskProposal, idempotencyKey: string) {
      if (!isTaskProposalUnchanged(proposal)) {
        return { status: "error" as const, reason: "proposal_changed" as const };
      }
      const { proposalId: _proposalId, ...task } = proposal;
      if (!adapter.createTask) return { status: "error" as const, reason: "unavailable" as const };
      try {
        const created = await adapter.createTask({ ...task, idempotencyKey });
        return { status: "ok" as const, taskId: created.taskId };
      } catch (error) {
        return { status: "error" as const,
          reason: error instanceof TasksAdapterError ? error.failure : "unavailable" as const };
      }
    },
  };
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
