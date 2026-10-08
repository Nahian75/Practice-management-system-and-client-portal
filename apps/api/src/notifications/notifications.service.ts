import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Database } from '../database/schema.js';
import type { Notification } from './notification.js';
import { NotificationsRepository } from './notifications.repository.js';
import { TaskMailService } from './task-mail.service.js';

export const NOTIFICATIONS_PAGE_SIZE = 50;

export interface NotificationActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly taskMail: TaskMailService,
  ) {}

  async list(recipientId: string, before?: string): Promise<{ notifications: Notification[]; next: string | null; unreadCount: number }> {
    const [notifications, unreadCount] = await Promise.all([
      this.notifications.list(recipientId, { before, limit: NOTIFICATIONS_PAGE_SIZE }),
      this.notifications.unreadCount(recipientId),
    ]);
    return {
      notifications,
      next: notifications.length === NOTIFICATIONS_PAGE_SIZE ? (notifications.at(-1)?.id ?? null) : null,
      unreadCount,
    };
  }

  async read(id: string, by: NotificationActor): Promise<boolean> {
    try {
      return await this.notifications.transaction(async (trx) => {
        const current = await this.notifications.findVisible(id, by.accountId, trx);
        if (!current) {
          return false;
        }
        if (current.readAt || !(await this.notifications.markRead(id, by.accountId, trx))) {
          return true;
        }
        await this.audit.record(
          {
            actor: by.actor,
            action: 'notification.read',
            outcome: 'success',
            resource: { type: 'notification', id },
            metadata: { taskId: current.taskId },
            ...by.context,
          },
          trx,
        );
        return true;
      });
    } catch (error) {
      if (isVisibilityRefusal(error)) {
        return false;
      }
      throw error;
    }
  }

  async auditCreated(keys: string[], by: NotificationActor, trx: Kysely<Database>): Promise<void> {
    const created = await this.notifications.createdForKeys(keys, trx);
    if (created.length !== keys.length) {
      throw new Error('The database did not create every expected notification');
    }
    for (const notification of created) {
      await this.audit.record(
        {
          actor: by.actor,
          action: 'notification.created',
          outcome: 'success',
          resource: { type: 'notification', id: notification.id },
          metadata: {
            recipientId: notification.recipientId,
            kind: notification.kind,
            taskId: notification.taskId,
          },
          ...by.context,
        },
        trx,
      );
      if (notification.kind === 'task_assigned') {
        await this.taskMail.queueAssignment(notification, by, trx);
      }
    }
  }
}

function isVisibilityRefusal(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === '23514' || error.code === '23503');
}
