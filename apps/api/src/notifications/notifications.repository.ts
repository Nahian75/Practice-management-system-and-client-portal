import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import type { CreatedNotification, Notification } from './notification.js';

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
      .select(['id', 'recipient_id', 'kind', 'task_id'])
      .where('deduplication_key', 'in', keys)
      .execute();
    return rows.map((row) => ({ id: row.id, recipientId: row.recipient_id, kind: row.kind, taskId: row.task_id }));
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
