import type { NotificationKind, TaskStatus } from '../database/schema.js';

export interface Notification {
  id: string;
  kind: NotificationKind;
  createdAt: Date;
  readAt: Date | null;
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    dueOn: string | null;
  };
}

export interface CreatedNotification {
  id: string;
  recipientId: string;
  kind: NotificationKind;
  taskId: string;
  recipientEmail: string;
}

export interface CreatedTaskReminder extends CreatedNotification {
  dueOn: string;
  reminderPoint: '7_days' | '1_day' | 'today' | 'overdue';
  deduplicationKey: string;
}

export const taskCreatedNotificationKey = (taskId: string, recipientId: string) =>
  `task:${taskId}:created:assigned:${recipientId}`;

export const taskAssignmentNotificationKey = (
  taskId: string,
  changeId: string,
  direction: 'assigned' | 'unassigned',
  recipientId: string,
) => `task:${taskId}:change:${changeId}:${direction}:${recipientId}`;

export const taskStatusNotificationKey = (
  taskId: string,
  changeId: string,
  status: TaskStatus,
  recipientId: string,
) => `task:${taskId}:change:${changeId}:${status === 'open' ? 'reopened' : status}:${recipientId}`;
