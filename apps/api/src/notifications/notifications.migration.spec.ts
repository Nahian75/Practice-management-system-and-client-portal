import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

interface NotificationRow {
  id: string;
  recipient_id: string;
  kind: string;
  task_id: string;
  deduplication_key: string;
  created_at: Date;
  read_at: Date | null;
}

describe('notification tables', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let creator: TestAccount;
  let assignee: TestAccount;
  let matterId: string;

  const uniqueName = () => {
    const letters = Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
    return letters[0]!.toUpperCase() + letters.slice(1);
  };

  async function staff(role: 'partner' | 'fee_earner' = 'fee_earner'): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    await grantTestRole(db, account.id, role);
    return account;
  }

  async function addToTeam(accountId: string, role: 'supervising_partner' | 'fee_earner' = 'fee_earner'): Promise<void> {
    await db
      .insertInto('matter_team')
      .values({ matter_id: matterId, account_id: accountId, role, added_by: creator.id })
      .execute();
  }

  async function openMatter(): Promise<string> {
    const clientId = await db.transaction().execute(async (trx) => {
      const client = await trx
        .insertInto('clients')
        .values({ kind: 'individual', created_by: creator.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('client_individuals')
        .values({ client_id: client.id, given_names: uniqueName(), family_name: uniqueName() })
        .execute();
      return client.id;
    });
    return db.transaction().execute(async (trx) => {
      const check = await trx
        .insertInto('conflict_checks')
        .values({ client_id: clientId, requested_by: creator.id, names: [uniqueName()] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const matter = await trx
        .insertInto('matters')
        .values({
          client_id: clientId,
          title: 'Notification test matter',
          matter_type: 'other',
          opened_by: creator.id,
          conflict_check_id: check.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('matter_team')
        .values({ matter_id: matter.id, account_id: creator.id, role: 'fee_earner', added_by: creator.id })
        .execute();
      await trx
        .insertInto('matter_team')
        .values({ matter_id: matter.id, account_id: assignee.id, role: 'supervising_partner', added_by: creator.id })
        .execute();
      return matter.id;
    });
  }

  async function addTask(recipient = assignee.id): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into tasks (matter_id, title, priority, assigned_to, created_by)
      values (${matterId}, 'Review the papers', 'normal', ${recipient}, ${creator.id})
      returning id
    `.execute(db);
    return rows[0]!.id;
  }

  async function notificationsFor(taskId: string, executor: Kysely<Database> = db): Promise<NotificationRow[]> {
    return (await sql<NotificationRow>`
      select id, recipient_id, kind, task_id, deduplication_key, created_at, read_at
      from notifications where task_id = ${taskId} order by id
    `.execute(executor)).rows;
  }

  async function databaseTime(): Promise<Date> {
    return (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db)).rows[0]!.now;
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await db.destroy();
  });

  beforeEach(async () => {
    creator = await staff();
    assignee = await staff('partner');
    matterId = await openMatter();
  });

  it('creates a database-timed assignment notification with no copied task text', async () => {
    const before = await databaseTime();
    const taskId = await addTask();

    expect(await notificationsFor(taskId)).toEqual([
      {
        id: expect.any(String),
        recipient_id: assignee.id,
        kind: 'task_assigned',
        task_id: taskId,
        deduplication_key: `task:${taskId}:created:assigned:${assignee.id}`,
        created_at: expect.any(Date),
        read_at: null,
      },
    ]);
    expect((await notificationsFor(taskId))[0]!.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(JSON.stringify((await notificationsFor(taskId))[0])).not.toContain('Review the papers');
  });

  it('notifies both people after reassignment, and the assignee after another person changes status', async () => {
    const next = await staff();
    await addToTeam(next.id);
    const taskId = await addTask();
    const assignment = (await sql<{ id: string }>`
      insert into task_changes (task_id, kind, to_assigned_to, changed_by)
      values (${taskId}, 'assignment', ${next.id}, ${creator.id}) returning id
    `.execute(db)).rows[0]!;

    expect(await notificationsFor(taskId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipient_id: assignee.id, kind: 'task_unassigned', deduplication_key: `task:${taskId}:change:${assignment.id}:unassigned:${assignee.id}` }),
      expect.objectContaining({ recipient_id: next.id, kind: 'task_assigned', deduplication_key: `task:${taskId}:change:${assignment.id}:assigned:${next.id}` }),
    ]));

    const status = (await sql<{ id: string }>`
      insert into task_changes (task_id, kind, to_status, changed_by)
      values (${taskId}, 'status', 'completed', ${assignee.id}) returning id
    `.execute(db)).rows[0]!;
    expect(await notificationsFor(taskId)).toContainEqual(
      expect.objectContaining({ recipient_id: next.id, kind: 'task_completed', deduplication_key: `task:${taskId}:change:${status.id}:completed:${next.id}` }),
    );
  });

  it('does not notify the assignee about their own status change or any no-op', async () => {
    const taskId = await addTask(creator.id);
    await sql`
      insert into task_changes (task_id, kind, to_assigned_to, changed_by)
      values (${taskId}, 'assignment', ${creator.id}, ${creator.id})
    `.execute(db);
    await sql`
      insert into task_changes (task_id, kind, to_status, changed_by)
      values (${taskId}, 'status', 'completed', ${creator.id})
    `.execute(db);

    expect((await notificationsFor(taskId)).map((row) => row.kind)).toEqual(['task_assigned']);
  });

  it('does not let the app insert, update, remove or truncate notifications directly', async () => {
    const taskId = await addTask();
    await expect(sql`
      insert into notifications (recipient_id, kind, task_id, deduplication_key)
      values (${assignee.id}, 'task_assigned', ${taskId}, ${randomUUID()})
    `.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`update notifications set read_at = clock_timestamp() where task_id = ${taskId}`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`delete from notifications where task_id = ${taskId}`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`truncate notifications`.execute(db)).rejects.toThrow(/permission denied/i);
  });

  it('refuses unknown kinds, client recipients and the wrong task recipient even for the table owner', async () => {
    const taskId = await addTask();
    const client = await createTestAccount(db, 'client');
    const insert = (recipientId: string, kind: string) => sql`
      insert into notifications (recipient_id, kind, task_id, deduplication_key)
      values (${recipientId}, ${kind}, ${taskId}, ${randomUUID()})
    `.execute(ownerDb);

    await expect(insert(assignee.id, 'unknown')).rejects.toThrow(/kind|check/i);
    await expect(insert(client.id, 'task_assigned')).rejects.toThrow(/staff recipient/i);
    await expect(insert(creator.id, 'task_assigned')).rejects.toThrow(/current assignee/i);
    await expect(insert(assignee.id, 'task_unassigned')).rejects.toThrow(/current assignee/i);
  });

  it('enforces one row per deduplication key', async () => {
    const taskId = await addTask();
    const row = (await notificationsFor(taskId))[0]!;

    await expect(sql`
      insert into notifications (recipient_id, kind, task_id, deduplication_key)
      values (${assignee.id}, 'task_assigned', ${taskId}, ${row.deduplication_key})
    `.execute(ownerDb)).rejects.toThrow(/unique|duplicate/i);
  });

  it('overwrites identity, creation time and read state supplied by the owner', async () => {
    const taskId = await addTask();
    const suppliedId = randomUUID();
    const old = new Date('2000-01-01T00:00:00Z');
    const { rows } = await sql<NotificationRow>`
      insert into notifications (id, recipient_id, kind, task_id, deduplication_key, created_at, read_at)
      values (${suppliedId}, ${assignee.id}, 'task_assigned', ${taskId}, ${randomUUID()}, ${old}, ${old})
      returning *
    `.execute(ownerDb);

    expect(rows[0]!.id).not.toBe(suppliedId);
    expect(rows[0]!.created_at.getTime()).toBeGreaterThan(old.getTime());
    expect(rows[0]!.read_at).toBeNull();
  });

  it('blocks owner edits and deletion of notification records', async () => {
    const taskId = await addTask();
    const row = (await notificationsFor(taskId))[0]!;

    await expect(sql`update notifications set kind = 'task_cancelled' where id = ${row.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`delete from notifications where id = ${row.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('blocks owner truncation of notification records', async () => {
    await addTask();

    await expect(sql`truncate notifications cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('marks a visible recipient notification read once using a database-set time', async () => {
    const taskId = await addTask();
    const row = (await notificationsFor(taskId))[0]!;
    const before = await databaseTime();
    const first = await sql<{ read_at: Date }>`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${assignee.id}) returning read_at
    `.execute(db);
    const second = await sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${assignee.id}) returning read_at
    `.execute(db);

    expect(first.rows[0]!.read_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(second.rows).toEqual([]);
    expect((await notificationsFor(taskId))[0]!.read_at).toEqual(first.rows[0]!.read_at);
  });

  it('refuses a different recipient and a recipient who has lost matter access', async () => {
    const taskId = await addTask(creator.id);
    const row = (await notificationsFor(taskId))[0]!;

    await expect(sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${assignee.id})
    `.execute(db)).rejects.toThrow(/named recipient/i);

    await db
      .updateTable('matter_team')
      .set({ removed_by: assignee.id, removed_at: new Date() })
      .where('matter_id', '=', matterId)
      .where('account_id', '=', creator.id)
      .execute();
    await expect(sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${creator.id})
    `.execute(db)).rejects.toThrow(/current matter access/i);
  });

  it('refuses a read after the recipient account is disabled', async () => {
    const taskId = await addTask(creator.id);
    const row = (await notificationsFor(taskId))[0]!;
    await setAccountStatus(db, creator.id, 'disabled');

    await expect(sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${creator.id})
    `.execute(db)).rejects.toThrow(/current matter access/i);
  });

  it('keeps read records safe from owner edits and deletion', async () => {
    const taskId = await addTask();
    const row = (await notificationsFor(taskId))[0]!;
    await sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${assignee.id})
    `.execute(db);

    await expect(sql`update notification_reads set recipient_id = ${creator.id} where notification_id = ${row.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`delete from notification_reads where notification_id = ${row.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('blocks owner truncation of notification read records', async () => {
    const taskId = await addTask();
    const row = (await notificationsFor(taskId))[0]!;
    await sql`
      insert into notification_reads (notification_id, recipient_id)
      values (${row.id}, ${assignee.id})
    `.execute(db);

    await expect(sql`truncate notification_reads`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });
});
