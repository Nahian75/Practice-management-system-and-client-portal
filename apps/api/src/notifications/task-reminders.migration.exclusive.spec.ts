import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, NotificationKind } from '../database/schema.js';

interface ReminderRow {
  notification_id: string;
  recipient_id: string;
  kind: NotificationKind;
  task_id: string;
  due_on: string;
  reminder_point: string;
  email: string;
  deduplication_key: string;
}

describe('task reminder database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let creator: TestAccount;
  let assignee: TestAccount;
  let matterId: string;
  let startsOn: string;

  const addDays = (date: string, days: number) => {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };

  const uniqueName = () => {
    const letters = Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
    return letters[0]!.toUpperCase() + letters.slice(1);
  };

  async function staff(role: 'partner' | 'fee_earner' = 'fee_earner'): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    await grantTestRole(db, account.id, role);
    return account;
  }

  async function addToTeam(accountId: string): Promise<void> {
    await db.insertInto('matter_team').values({
      matter_id: matterId,
      account_id: accountId,
      role: 'fee_earner',
      added_by: creator.id,
    }).execute();
  }

  async function openMatter(): Promise<string> {
    const client = await db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('clients').values({ kind: 'individual', created_by: creator.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: created.id,
        given_names: uniqueName(),
        family_name: uniqueName(),
      }).execute();
      return created;
    });
    const check = await db.insertInto('conflict_checks').values({
      client_id: client.id,
      requested_by: creator.id,
      names: [uniqueName()],
    }).returning('id').executeTakeFirstOrThrow();
    return db.transaction().execute(async (trx) => {
      const matter = await trx.insertInto('matters').values({
        client_id: client.id,
        title: 'Reminder test matter',
        matter_type: 'other',
        opened_by: creator.id,
        conflict_check_id: check.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: creator.id, role: 'fee_earner', added_by: creator.id },
        { matter_id: matter.id, account_id: assignee.id, role: 'supervising_partner', added_by: creator.id },
      ]).execute();
      return matter.id;
    });
  }

  async function addTask(dueOn: string | null, recipient = assignee.id): Promise<string> {
    return (await db.insertInto('tasks').values({
      matter_id: matterId,
      title: `Private task ${uniqueName()}`,
      description: 'Private client instructions',
      due_on: dueOn,
      priority: 'normal',
      assigned_to: recipient,
      created_by: creator.id,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async function run(through = startsOn): Promise<ReminderRow[]> {
    return (await sql<ReminderRow>`select * from create_task_reminders_through(${through}::date)`.execute(db)).rows;
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
    startsOn = (await sql<{ starts_on: string }>`select starts_on::text from notification_reminder_settings`.execute(db)).rows[0]!.starts_on;
    creator = await staff();
    assignee = await staff('partner');
    matterId = await openMatter();
  });

  it('creates the four due points once with stable keys and no copied task text', async () => {
    const tasks = {
      seven: await addTask(addDays(startsOn, 7)),
      one: await addTask(addDays(startsOn, 1)),
      today: await addTask(startsOn),
      overdue: await addTask(addDays(startsOn, -1)),
    };

    const created = await run();
    const taskIds = Object.values(tasks);
    const rows = created.filter((row) => taskIds.includes(row.task_id));

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: tasks.seven, kind: 'task_due_soon', reminder_point: '7_days' }),
      expect.objectContaining({ task_id: tasks.one, kind: 'task_due_soon', reminder_point: '1_day' }),
      expect.objectContaining({ task_id: tasks.today, kind: 'task_due_today', reminder_point: 'today' }),
      expect.objectContaining({ task_id: tasks.overdue, kind: 'task_overdue', reminder_point: 'overdue' }),
    ]));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.recipient_id === assignee.id && row.email === assignee.email)).toBe(true);
    expect(rows.map((row) => row.deduplication_key)).toEqual(expect.arrayContaining([
      `task:${tasks.seven}:due:${addDays(startsOn, 7)}:7_days:${assignee.id}`,
      `task:${tasks.one}:due:${addDays(startsOn, 1)}:1_day:${assignee.id}`,
      `task:${tasks.today}:due:${startsOn}:today:${assignee.id}`,
      `task:${tasks.overdue}:due:${addDays(startsOn, -1)}:overdue:${assignee.id}`,
    ]));
    expect(JSON.stringify(await db.selectFrom('notifications').selectAll().where('id', 'in', rows.map((row) => row.notification_id)).execute()))
      .not.toContain('Private task');
    expect((await run()).filter((row) => taskIds.includes(row.task_id))).toEqual([]);
  });

  it('processes every reminder point through the supplied current date', async () => {
    const londonToday = (await sql<{ today: string }>`
      select (clock_timestamp() at time zone 'Europe/London')::date::text as today
    `.execute(db)).rows[0]!.today;
    const taskId = await addTask(addDays(londonToday, 7));

    const rows = (await run(londonToday)).filter((row) => row.task_id === taskId);

    expect(rows).toEqual([
      expect.objectContaining({ task_id: taskId, due_on: addDays(londonToday, 7), reminder_point: '7_days' }),
    ]);
    expect((await run(londonToday)).filter((row) => row.task_id === taskId)).toEqual([]);
  });

  it('skips tasks without a due date and assignees who are no longer active on the matter', async () => {
    const noDate = await addTask(null);
    const removedAssignee = await staff();
    await addToTeam(removedAssignee.id);
    const removed = await addTask(startsOn, removedAssignee.id);
    const disabledAssignee = await staff();
    await addToTeam(disabledAssignee.id);
    const disabled = await addTask(startsOn, disabledAssignee.id);
    const finishedAssignee = await staff();
    await addToTeam(finishedAssignee.id);
    const completed = await addTask(startsOn, finishedAssignee.id);
    const cancelled = await addTask(startsOn, finishedAssignee.id);
    await db.insertInto('task_changes').values({
      task_id: completed,
      kind: 'status',
      to_status: 'completed',
      changed_by: finishedAssignee.id,
    }).execute();
    await db.insertInto('task_changes').values({
      task_id: cancelled,
      kind: 'status',
      to_status: 'cancelled',
      changed_by: finishedAssignee.id,
    }).execute();
    await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: creator.id })
      .where('matter_id', '=', matterId).where('account_id', '=', removedAssignee.id).execute();
    await setAccountStatus(db, disabledAssignee.id, 'disabled');

    const rows = await run();

    expect(rows.map((row) => row.task_id)).not.toEqual(expect.arrayContaining([
      noDate,
      removed,
      disabled,
      completed,
      cancelled,
    ]));
  });

  it('keeps the reminder start date under database control', async () => {
    await expect(sql`update notification_reminder_settings set starts_on = DATE '2099-01-01'`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`update notification_reminder_settings set starts_on = DATE '2099-01-01'`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`delete from notification_reminder_settings`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`truncate notification_reminder_settings`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('refuses to create reminders for a future London calendar date', async () => {
    const londonToday = (await sql<{ today: string }>`
      select (clock_timestamp() at time zone 'Europe/London')::date::text as today
    `.execute(db)).rows[0]!.today;
    await addTask(addDays(londonToday, 8));

    await expect(run(addDays(londonToday, 1))).rejects.toThrow(/future London calendar date/i);
  });

  it('waits for the single reminder-batch advisory lock', async () => {
    const holder = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    await sql`select pg_advisory_lock(hashtextextended('app.task_reminders', 0))`.execute(holder);
    const pending = run();
    try {
      expect(await Promise.race([
        pending.then(() => 'finished' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])).toBe('waiting');
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended('app.task_reminders', 0))`.execute(holder);
      await holder.destroy();
    }
    await pending;
  });
});
