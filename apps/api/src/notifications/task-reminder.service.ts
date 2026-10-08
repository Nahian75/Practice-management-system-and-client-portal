import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsRepository } from './notifications.repository.js';
import { TaskMailService } from './task-mail.service.js';

@Injectable()
export class TaskReminderService {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly taskMail: TaskMailService,
  ) {}

  async run(throughLondonDate: string): Promise<number> {
    return this.notifications.transaction(async (trx) => {
      const created = await this.notifications.createReminders(throughLondonDate, trx);
      for (const notification of created) {
        await this.audit.record({
          actor: { type: 'system' },
          action: 'notification.created',
          outcome: 'success',
          resource: { type: 'notification', id: notification.id },
          metadata: {
            recipientId: notification.recipientId,
            kind: notification.kind,
            taskId: notification.taskId,
          },
        }, trx);
        await this.taskMail.queueReminder(notification, trx);
      }
      return created.length;
    });
  }
}
