import type { TaskStatus } from './tasks';

export const NOTIFICATION_KIND_LABELS = {
  task_assigned: 'Task assigned to you',
  task_unassigned: 'Task reassigned from you',
  task_completed: 'Task completed',
  task_cancelled: 'Task cancelled',
  task_reopened: 'Task reopened',
  task_due_soon: 'Task due soon',
  task_due_today: 'Task due today',
  task_overdue: 'Task overdue',
} as const;

export interface Notification {
  id: string;
  kind: keyof typeof NOTIFICATION_KIND_LABELS;
  createdAt: string;
  readAt: string | null;
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    dueOn: string | null;
  };
}

export interface NotificationPage {
  notifications: Notification[];
  next: string | null;
  unreadCount: number;
}
