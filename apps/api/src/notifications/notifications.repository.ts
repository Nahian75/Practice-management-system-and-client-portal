import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import type { CreatedNotification, CreatedTaskReminder, Notification } from './notification.js';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async createdForKeys(keys: string[], trx: Kysely<Database>): Promise<CreatedNotification[]> {
    if (keys.length === 0) {
      return [];
    }
    const rows = await trx
      .selectFrom('notifications')
      .innerJoin('accounts', 'accounts.id', 'notifications.recipient_id')
      .select(['notifications.id', 'notifications.recipient_id', 'notifications.kind', 'notifications.task_id', 'accounts.email'])
      .where('deduplication_key', 'in', keys)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      recipientId: row.recipient_id,
      kind: row.kind,
      taskId: row.task_id,
      recipientEmail: row.email,
    }));
  }

  async createReminders(throughDate: string, trx: Kysely<Database>): Promise<CreatedTaskReminder[]> {
    const rows = (await sql<{
      notification_id: string;
      recipient_id: string;
      kind: CreatedTaskReminder['kind'];
      task_id: string;
      due_on: string;
      reminder_point: CreatedTaskReminder['reminderPoint'];
      email: string;
      deduplication_key: string;
    }>`select * from create_task_reminders_through(${throughDate}::date)`.execute(trx)).rows;
    return rows.map((row) => ({
      id: row.notification_id,
      recipientId: row.recipient_id,
      kind: row.kind,
      taskId: row.task_id,
      recipientEmail: row.email,
      dueOn: row.due_on,
      reminderPoint: row.reminder_point,
      deduplicationKey: row.deduplication_key,
    }));
  }

  async list(recipientId: string, page: { before?: string; limit: number }): Promise<Notification[]> {
    const rows = await this.visibleRows(this.db, recipientId)
      .$if(page.before !== undefined, (query) => query.where('notifications.id', '<', page.before as string))
      .orderBy('notifications.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      readAt: row.read_at,
      task: { id: row.task_id, title: row.task_title, status: row.task_status, dueOn: row.task_due_on },
    }));
  }

  async unreadCount(recipientId: string): Promise<number> {
    const row = await this.visibleRows(this.db, recipientId)
      .clearSelect()
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('notifications.read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async findVisible(id: string, recipientId: string, trx: Kysely<Database>): Promise<{ taskId: string; readAt: Date | null } | undefined> {
    const row = await this.visibleRows(trx, recipientId)
      .clearSelect()
      .select(['notifications.task_id', 'notifications.read_at'])
      .where('notifications.id', '=', id)
      .executeTakeFirst();
    return row ? { taskId: row.task_id, readAt: row.read_at } : undefined;
  }

  async markRead(id: string, recipientId: string, trx: Kysely<Database>): Promise<boolean> {
    const row = await trx
      .insertInto('notification_reads')
      .values({ notification_id: id, recipient_id: recipientId })
      .returning('read_at')
      .executeTakeFirst();
    return row !== undefined;
  }

  private visibleRows(executor: Kysely<Database>, recipientId: string) {
    return executor
      .selectFrom('notifications')
      .innerJoin('tasks', 'tasks.id', 'notifications.task_id')
      .innerJoin('matters', 'matters.id', 'tasks.matter_id')
      .select([
        'notifications.id',
        'notifications.kind',
        'notifications.created_at',
        'notifications.read_at',
        'tasks.id as task_id',
        'tasks.title as task_title',
        'tasks.status as task_status',
        'tasks.due_on as task_due_on',
      ])
      .where('notifications.recipient_id', '=', recipientId)
      .where(visibleTo(recipientId));
  }
}
