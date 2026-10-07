/** Matter tasks as the API returns them, and how their codes are shown. */

export const TASK_PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;
export const TASK_STATUS_LABELS = { open: 'Open', completed: 'Completed', cancelled: 'Cancelled' } as const;

export type TaskPriority = keyof typeof TASK_PRIORITY_LABELS;
export type TaskStatus = keyof typeof TASK_STATUS_LABELS;

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
  createdAt: string;
}

export type TaskChange =
  | {
      id: string;
      kind: 'details';
      from: { title: string; description: string | null; dueOn: string | null; priority: TaskPriority };
      to: { title: string; description: string | null; dueOn: string | null; priority: TaskPriority };
      changedBy: TaskPerson;
      changedAt: string;
    }
  | {
      id: string;
      kind: 'assignment';
      from: TaskPerson;
      to: TaskPerson;
      changedBy: TaskPerson;
      changedAt: string;
    }
  | {
      id: string;
      kind: 'status';
      from: TaskStatus;
      to: TaskStatus;
      changedBy: TaskPerson;
      changedAt: string;
    };

export interface TaskDetails extends Task {
  changes: TaskChange[];
}
