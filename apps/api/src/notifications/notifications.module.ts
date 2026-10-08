import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { TaskReminderScheduler } from './notification-schedule.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { TaskMailService } from './task-mail.service.js';
import { TaskReminderService } from './task-reminder.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, MailModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    TaskMailService,
    TaskReminderService,
    TaskReminderScheduler,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
