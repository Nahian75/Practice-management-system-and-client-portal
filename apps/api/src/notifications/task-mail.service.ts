import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import type { RequestContext } from '../common/http/request-context.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { Database } from '../database/schema.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import type { CreatedNotification, CreatedTaskReminder } from './notification.js';

interface TaskMailActor {
  actor: AuditActor;
  context?: RequestContext;
}

@Injectable()
export class TaskMailService {
  constructor(
    private readonly outbox: MailOutbox,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async queueAssignment(
    notification: CreatedNotification,
    by: TaskMailActor,
    trx: Kysely<Database>,
  ): Promise<void> {
    await this.outbox.enqueueInTransaction(this.message(notification.recipientEmail, notification.taskId), {
      kind: 'task_assignment',
      recipientAccountId: notification.recipientId,
      resource: { type: 'task', id: notification.taskId },
      deduplicationKey: `task-email:assignment:${notification.id}`,
      actor: by.actor,
      context: by.context,
    }, trx);
  }

  async queueReminder(notification: CreatedTaskReminder, trx: Kysely<Database>): Promise<void> {
    await this.outbox.enqueueInTransaction(this.message(notification.recipientEmail, notification.taskId), {
      kind: 'task_reminder',
      recipientAccountId: notification.recipientId,
      resource: { type: 'task', id: notification.taskId },
      deduplicationKey: `task-email:reminder:${notification.taskId}:${notification.dueOn}:${notification.reminderPoint}:${notification.recipientId}`,
    }, trx);
  }

  private message(to: string, taskId: string) {
    const link = new URL(`/tasks/${taskId}`, this.env.APP_BASE_URL).toString();
    return {
      to,
      subject: 'A task needs your attention',
      text: [
        'A task in Stass needs your attention.',
        '',
        'Sign in to see it:',
        link,
        '',
        'This email deliberately contains no client or task details.',
      ].join('\n'),
    };
  }
}
