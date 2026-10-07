import type { TaskPriority, TaskStatus } from '../database/schema.js';

export interface TaskPerson {
  accountId: string;
  displayName: string;
}

export interface Task {
  id: string;
  matterId: string;
  title: string;
  description: string | null;
  dueOn: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  assignee: TaskPerson;
  createdBy: TaskPerson;
  createdAt: Date;
}

interface TaskChangeBase {
  id: string;
  changedBy: TaskPerson;
  changedAt: Date;
}

export type TaskChange =
  | (TaskChangeBase & {
      kind: 'details';
      from: { title: string; description: string | null; dueOn: string | null; priority: TaskPriority };
      to: { title: string; description: string | null; dueOn: string | null; priority: TaskPriority };
    })
  | (TaskChangeBase & { kind: 'assignment'; from: TaskPerson; to: TaskPerson })
  | (TaskChangeBase & { kind: 'status'; from: TaskStatus; to: TaskStatus });

export interface TaskDetails extends Task {
  canChangeStatus: boolean;
  changes: TaskChange[];
}

export interface NewTask {
  matterId: string;
  title: string;
  description: string | null;
  dueOn: string | null;
  priority: TaskPriority;
  assigneeId: string;
  createdBy: string;
}
