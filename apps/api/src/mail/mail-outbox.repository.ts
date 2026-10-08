import { Inject, Injectable } from '@nestjs/common';
import { sql, type Insertable, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, EmailFailureClass, EmailKind, EmailOutboxTable } from '../database/schema.js';

export interface NewEmailOutbox {
  kind: EmailKind;
  recipientAccountId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  deduplicationKey: string | null;
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  notBefore?: Date;
  discardAfter: Date | null;
}

export interface ClaimedEmail {
  id: string;
  kind: EmailKind;
  recipientAccountId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  deduplicationKey: string | null;
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  queuedAt: Date;
  expiresAt: Date;
  discardAfter: Date | null;
  attemptCount: number;
  leaseId: string;
  databaseNow: Date;
}

export type EmailDeliveryOutcome =
  | { outcome: 'sent' | 'discarded' }
  | { outcome: 'retry'; retryAfterSeconds: number; failureClass: 'temporary' }
  | { outcome: 'failed'; failureClass: Exclude<EmailFailureClass, 'temporary'> };

interface ClaimedRow {
  id: string;
  kind: EmailKind;
  recipient_account_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  deduplication_key: string | null;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  queued_at: Date;
  expires_at: Date;
  discard_after: Date | null;
  attempt_count: number;
  lease_id: string;
  database_now: Date;
}

@Injectable()
export class MailOutboxRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async enqueue(
    message: NewEmailOutbox,
    executor: Kysely<Database> = this.db,
  ): Promise<{ id: string; created: boolean }> {
    const row: Insertable<EmailOutboxTable> = {
      kind: message.kind,
      recipient_account_id: message.recipientAccountId,
      resource_type: message.resourceType,
      resource_id: message.resourceId,
      deduplication_key: message.deduplicationKey,
      key_version: message.keyVersion,
      nonce: message.nonce,
      ciphertext: message.ciphertext,
      auth_tag: message.authTag,
      not_before: message.notBefore,
      discard_after: message.discardAfter,
    };
    const inserted = await executor
      .insertInto('email_outbox')
      .values(row)
      .onConflict((conflict) => conflict.column('deduplication_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      return { id: inserted.id, created: true };
    }
    if (!message.deduplicationKey) {
      throw new Error('Email outbox insert did not return an id');
    }
    const existing = await executor
      .selectFrom('email_outbox')
      .select('id')
      .where('deduplication_key', '=', message.deduplicationKey)
      .executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }

  async claim(): Promise<ClaimedEmail | undefined> {
    const result = await sql<ClaimedRow>`
      select claimed.*, clock_timestamp() as database_now
      from claim_email_outbox() claimed
    `.execute(this.db);
    const row = result.rows[0];
    return row && {
      id: row.id,
      kind: row.kind,
      recipientAccountId: row.recipient_account_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      deduplicationKey: row.deduplication_key,
      keyVersion: row.key_version,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
      queuedAt: row.queued_at,
      expiresAt: row.expires_at,
      discardAfter: row.discard_after,
      attemptCount: row.attempt_count,
      leaseId: row.lease_id,
      databaseNow: row.database_now,
    };
  }

  async finish(
    id: string,
    leaseId: string,
    result: EmailDeliveryOutcome,
    executor: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const retryAfter = result.outcome === 'retry' ? result.retryAfterSeconds : null;
    const failureClass = 'failureClass' in result ? result.failureClass : null;
    const finished = await sql<{ accepted: boolean }>`
      select finish_email_outbox(
        ${id}, ${leaseId}, ${result.outcome}, ${retryAfter}, ${failureClass}
      ) as accepted
    `.execute(executor);
    return finished.rows[0]?.accepted === true;
  }

  async hasDue(): Promise<boolean> {
    const row = await this.db
      .selectFrom('email_outbox')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', '=', 'pending')
      .where('not_before', '<=', sql<Date>`clock_timestamp()`)
      .executeTakeFirstOrThrow();
    return Number(row.count) > 0;
  }

  async taskEmailIsCurrent(message: Pick<ClaimedEmail,
    'kind' | 'recipientAccountId' | 'resourceType' | 'resourceId' | 'deduplicationKey'
  >, recipientEmail: string): Promise<boolean> {
    if (message.kind !== 'task_assignment' && message.kind !== 'task_reminder') {
      return true;
    }
    if (!message.recipientAccountId || message.resourceType !== 'task' || !message.resourceId || !message.deduplicationKey) {
      return false;
    }

    let expectedDueOn: string | undefined;
    if (message.kind === 'task_assignment') {
      if (!/^task-email:assignment:[0-9a-f-]{36}$/.test(message.deduplicationKey)) {
        return false;
      }
    } else {
      const matched = /^task-email:reminder:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2}):(7_days|1_day|today|overdue):([0-9a-f-]{36})$/
        .exec(message.deduplicationKey);
      if (!matched || matched[1] !== message.resourceId || matched[4] !== message.recipientAccountId) {
        return false;
      }
      expectedDueOn = matched[2];
    }

    let query = this.db
      .selectFrom('tasks')
      .innerJoin('matters', 'matters.id', 'tasks.matter_id')
      .innerJoin('matter_team', (join) => join
        .onRef('matter_team.matter_id', '=', 'tasks.matter_id')
        .onRef('matter_team.account_id', '=', 'tasks.assigned_to'))
      .innerJoin('accounts', 'accounts.id', 'tasks.assigned_to')
      .select('tasks.id')
      .where('tasks.id', '=', message.resourceId)
      .where('tasks.assigned_to', '=', message.recipientAccountId)
      .where('tasks.status', '=', 'open')
      .where('matters.status', '=', 'open')
      .where('matter_team.removed_at', 'is', null)
      .where('accounts.kind', '=', 'staff')
      .where('accounts.status', '=', 'active')
      .where('accounts.email', '=', recipientEmail);
    if (expectedDueOn) {
      query = query.where('tasks.due_on', '=', expectedDueOn);
    }
    return (await query.executeTakeFirst()) !== undefined;
  }

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}
