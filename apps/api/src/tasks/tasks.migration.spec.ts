import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('tasks table', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let matterId: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  async function insertClient(familyName = uniqueName()): Promise<string> {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: client.id, given_names: 'Test', family_name: familyName }).execute();
      return client.id;
    });
  }

  async function openMatter(possibleConflict = uniqueName()): Promise<{ id: string; status: string }> {
    const clientId = await insertClient();
    return db.transaction().execute(async (trx) => {
      const check = await trx
        .insertInto('conflict_checks')
        .values({ client_id: clientId, requested_by: feeEarner.id, names: [possibleConflict] })
        .returning('id')
        .executeTakeFirstOrThrow();
      const matter = await trx
        .insertInto('matters')
        .values({ client_id: clientId, title: 'Lease renewal', matter_type: 'commercial_property', opened_by: feeEarner.id, conflict_check_id: check.id })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values({ matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id }).execute();
      await trx.insertInto('matter_team').values({ matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id }).execute();
      return matter;
    });
  }

  async function addTask(
    matter = matterId,
    creator = feeEarner.id,
    assignee = feeEarner.id,
    overrides: { title?: string; description?: string | null; dueOn?: string | null; priority?: string } = {},
  ) {
    const result = await sql<{ id: string; title: string; description: string | null; due_on: string | null; priority: string; status: string; created_at: Date }>`
      insert into tasks (matter_id, title, description, due_on, priority, assigned_to, created_by)
      values (${matter}, ${overrides.title ?? 'Review draft contract'}, ${overrides.description ?? null}, ${overrides.dueOn ?? null}, ${overrides.priority ?? 'normal'}, ${assignee}, ${creator})
      returning id, title, description, due_on, priority, status, created_at
    `.execute(db);
    return result.rows[0]!;
  }

  async function addChange(
    taskId: string,
    kind: 'details' | 'assignment' | 'status',
    changedBy: string,
    to: {
      title?: string | null;
      description?: string | null;
      dueOn?: string | null;
      priority?: string | null;
      assignedTo?: string | null;
      status?: string | null;
    } = {},
  ) {
    const result = await sql<{ id: string }>`
      insert into task_changes (
        task_id, kind, to_title, to_description, to_due_on,
        to_priority, to_assigned_to, to_status, changed_by
      ) values (
        ${taskId}, ${kind}, ${to.title ?? null}, ${to.description ?? null},
        ${to.dueOn ?? null}, ${to.priority ?? null}, ${to.assignedTo ?? null},
        ${to.status ?? null}, ${changedBy}
      ) returning id
    `.execute(db);
    return result.rows[0];
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 1);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await db.destroy();
  });

  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    matterId = (await openMatter()).id;
  });

  it('creates an open task with its database-set identity and time', async () => {
    const task = await addTask(matterId, feeEarner.id, partner.id, {
      title: 'Prepare completion statement',
      description: 'Check the agreed figures.',
      dueOn: '2027-02-12',
      priority: 'high',
    });

    expect(task).toMatchObject({
      id: expect.any(String),
      title: 'Prepare completion statement',
      description: 'Check the agreed figures.',
      due_on: '2027-02-12',
      priority: 'high',
      status: 'open',
      created_at: expect.any(Date),
    });
  });

  describe('who can create and be assigned', () => {
    it('refuses a creator outside the active matter team', async () => {
      const outsider = await staffWith('fee_earner');

      await expect(addTask(matterId, outsider.id)).rejects.toThrow(/active matter team/);
    });

    it('refuses a disabled creator even while their team membership remains', async () => {
      await setAccountStatus(db, feeEarner.id, 'disabled');

      await expect(addTask()).rejects.toThrow(/active matter team/);
    });

    it('refuses an assignee outside the team, removed from it, or disabled', async () => {
      const outsider = await staffWith('fee_earner');
      await expect(addTask(matterId, feeEarner.id, outsider.id)).rejects.toThrow(/assignee.*active matter team/);

      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: outsider.id, role: 'fee_earner', added_by: partner.id }).execute();
      await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: partner.id }).where('matter_id', '=', matterId).where('account_id', '=', outsider.id).execute();
      await expect(addTask(matterId, feeEarner.id, outsider.id)).rejects.toThrow(/assignee.*active matter team/);

      const disabled = await staffWith('fee_earner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: disabled.id, role: 'fee_earner', added_by: partner.id }).execute();
      await setAccountStatus(db, disabled.id, 'disabled');
      await expect(addTask(matterId, feeEarner.id, disabled.id)).rejects.toThrow(/assignee.*active matter team/);
    });
  });

  describe('matter state', () => {
    it('refuses a matter awaiting conflict clearance', async () => {
      const matchingName = uniqueName();
      await insertClient(matchingName);
      const awaiting = await openMatter(`Test ${matchingName}`);
      expect(awaiting.status).toBe('awaiting_clearance');

      await expect(addTask(awaiting.id)).rejects.toThrow(/only on open matters/);
    });

    it('refuses a closed matter', async () => {
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();

      await expect(addTask()).rejects.toThrow(/only on open matters/);
    });

    it('orders a simultaneous closure before creation and then refuses the task', async () => {
      let closureStarted!: () => void;
      let finishClosure!: () => void;
      const started = new Promise<void>((resolve) => (closureStarted = resolve));
      const finish = new Promise<void>((resolve) => (finishClosure = resolve));
      const closing = ownerDb.transaction().execute(async (trx) => {
        await trx.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();
        closureStarted();
        await finish;
      });
      await started;

      const creating = addTask();
      const early = await Promise.race([
        creating.then(
          () => 'finished',
          () => 'finished',
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(early).toBe('waiting');

      finishClosure();
      await closing;
      await expect(creating).rejects.toThrow(/only on open matters/);
    });
  });

  describe('valid values', () => {
    it.each([
      ['an empty title', { title: '' }],
      ['a title over 200 characters', { title: 'x'.repeat(201) }],
      ['unsafe title text', { title: `line${String.fromCharCode(1)}break` }],
      ['a description over 2,000 characters', { description: 'x'.repeat(2_001) }],
      ['unsafe description text', { description: `line${String.fromCharCode(1)}break` }],
      ['an unknown priority', { priority: 'immediate' }],
      ['a due date outside the supported range', { dueOn: '1800-01-01' }],
    ])('refuses %s', async (_case, values) => {
      await expect(addTask(matterId, feeEarner.id, feeEarner.id, values)).rejects.toThrow(/violates check constraint/);
    });
  });

  describe('records cannot be rewritten', () => {
    it.each([
      ['choose the id', () => sql`insert into tasks (id, matter_id, title, assigned_to, created_by) values (${randomUUID()}, ${matterId}, 'Chosen id', ${feeEarner.id}, ${feeEarner.id})`],
      ['choose the status', () => sql`insert into tasks (matter_id, title, status, assigned_to, created_by) values (${matterId}, 'Already done', 'completed', ${feeEarner.id}, ${feeEarner.id})`],
      ['change a task', (id: string) => sql`update tasks set title = 'Changed' where id = ${id}`],
      ['remove a task', (id: string) => sql`delete from tasks where id = ${id}`],
    ])('does not let the app %s', async (_case, statement) => {
      const task = await addTask();

      await expect(statement(task.id).execute(db)).rejects.toThrow(/permission denied/);
    });

    it.each([
      ['change', (id: string) => sql`update tasks set title = 'Changed' where id = ${id}`],
      ['remove', (id: string) => sql`delete from tasks where id = ${id}`],
    ])('does not let even the owner %s a task', async (_case, statement) => {
      const task = await addTask();

      await expect(statement(task.id).execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
    });

    it('does not let even the owner create a task already completed', async () => {
      const insert = sql`
        insert into tasks (matter_id, title, status, assigned_to, created_by)
        values (${matterId}, 'Already done', 'completed', ${feeEarner.id}, ${feeEarner.id})
      `.execute(ownerDb);

      await expect(insert).rejects.toThrow(/must start open/);
    });
  });

  describe('insert-only changes', () => {
    it('changes details and keeps the complete before and after values', async () => {
      const task = await addTask(matterId, feeEarner.id, feeEarner.id, {
        description: 'First description',
        dueOn: '2027-02-12',
      });

      const change = await addChange(task.id, 'details', partner.id, {
        title: 'Review final contract',
        description: null,
        dueOn: '2027-02-15',
        priority: 'urgent',
      });

      expect(change?.id).toEqual(expect.any(String));
      const current = await sql<{ title: string; description: string | null; due_on: string | null; priority: string }>`
        select title, description, due_on, priority from tasks where id = ${task.id}
      `.execute(db);
      expect(current.rows[0]).toEqual({ title: 'Review final contract', description: null, due_on: '2027-02-15', priority: 'urgent' });
      const history = await sql<{
        from_title: string;
        to_title: string;
        from_description: string | null;
        to_description: string | null;
        from_due_on: string | null;
        to_due_on: string | null;
        from_priority: string;
        to_priority: string;
      }>`select from_title, to_title, from_description, to_description, from_due_on, to_due_on, from_priority, to_priority
          from task_changes where id = ${change!.id}`.execute(db);
      expect(history.rows[0]).toEqual({
        from_title: 'Review draft contract',
        to_title: 'Review final contract',
        from_description: 'First description',
        to_description: null,
        from_due_on: '2027-02-12',
        to_due_on: '2027-02-15',
        from_priority: 'normal',
        to_priority: 'urgent',
      });
    });

    it('reassigns only to an active member of the same matter team', async () => {
      const task = await addTask();
      const change = await addChange(task.id, 'assignment', feeEarner.id, { assignedTo: partner.id });

      const current = await sql<{ assigned_to: string }>`select assigned_to from tasks where id = ${task.id}`.execute(db);
      const history = await sql<{ from_assigned_to: string; to_assigned_to: string }>`
        select from_assigned_to, to_assigned_to from task_changes where id = ${change!.id}
      `.execute(db);
      expect(current.rows[0]?.assigned_to).toBe(partner.id);
      expect(history.rows[0]).toEqual({ from_assigned_to: feeEarner.id, to_assigned_to: partner.id });

      const outsider = await staffWith('fee_earner');
      await expect(addChange(task.id, 'assignment', feeEarner.id, { assignedTo: outsider.id })).rejects.toThrow(/assignee.*active matter team/);
    });

    it('lets the assignee or supervising partner complete, cancel and reopen', async () => {
      const completed = await addTask();
      await addChange(completed.id, 'status', feeEarner.id, { status: 'completed' });
      await addChange(completed.id, 'status', partner.id, { status: 'open' });
      await addChange(completed.id, 'status', partner.id, { status: 'cancelled' });

      const current = await sql<{ status: string }>`select status from tasks where id = ${completed.id}`.execute(db);
      const history = await sql<{ from_status: string; to_status: string }>`
        select from_status, to_status from task_changes where task_id = ${completed.id} order by id
      `.execute(db);
      expect(current.rows[0]?.status).toBe('cancelled');
      expect(history.rows).toEqual([
        { from_status: 'open', to_status: 'completed' },
        { from_status: 'completed', to_status: 'open' },
        { from_status: 'open', to_status: 'cancelled' },
      ]);
    });

    it('refuses status changes by another fee earner on the team', async () => {
      const colleague = await staffWith('fee_earner');
      await db.insertInto('matter_team').values({ matter_id: matterId, account_id: colleague.id, role: 'fee_earner', added_by: partner.id }).execute();
      const task = await addTask();

      await expect(addChange(task.id, 'status', colleague.id, { status: 'completed' })).rejects.toThrow(/assignee or supervising partner/);
    });

    it('refuses status changes by a recorded supervisor who no longer holds the partner role', async () => {
      const task = await addTask();
      await revokeTestRole(db, partner.id, 'partner');

      await expect(addChange(task.id, 'status', partner.id, { status: 'completed' })).rejects.toThrow(/active partner role/);
    });

    it('waits for a simultaneous partner-role removal, then refuses the supervisor status change', async () => {
      const task = await addTask();
      let removalStarted!: () => void;
      let finishRemoval!: () => void;
      const started = new Promise<void>((resolve) => (removalStarted = resolve));
      const finish = new Promise<void>((resolve) => (finishRemoval = resolve));
      const removing = ownerDb.transaction().execute(async (trx) => {
        await trx
          .updateTable('account_roles')
          .set({ revoked_at: new Date() })
          .where('account_id', '=', partner.id)
          .where('role', '=', 'partner')
          .where('revoked_at', 'is', null)
          .execute();
        removalStarted();
        await finish;
      });
      await started;

      const changing = addChange(task.id, 'status', partner.id, { status: 'completed' });
      const early = await Promise.race([
        changing.then(
          () => 'finished',
          () => 'finished',
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(early).toBe('waiting');

      finishRemoval();
      await removing;
      await expect(changing).rejects.toThrow(/active partner role/);
    });

    it('refuses every kind of change from outside the active team', async () => {
      const outsider = await staffWith('fee_earner');
      const task = await addTask();

      await expect(
        addChange(task.id, 'details', outsider.id, { title: 'Changed', description: null, dueOn: null, priority: 'normal' }),
      ).rejects.toThrow(/active matter team/);
      await expect(addChange(task.id, 'assignment', outsider.id, { assignedTo: partner.id })).rejects.toThrow(/active matter team/);
      await expect(addChange(task.id, 'status', outsider.id, { status: 'completed' })).rejects.toThrow(/active matter team/);
    });

    it('refuses changing directly between completed and cancelled', async () => {
      const task = await addTask();
      await addChange(task.id, 'status', feeEarner.id, { status: 'completed' });

      await expect(addChange(task.id, 'status', partner.id, { status: 'cancelled' })).rejects.toThrow(/reopened before/);
    });

    it('refuses every change after the matter closes', async () => {
      const task = await addTask();
      await addChange(task.id, 'status', feeEarner.id, { status: 'cancelled' });
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();

      await expect(
        addChange(task.id, 'details', partner.id, { title: 'Changed', description: null, dueOn: null, priority: 'normal' }),
      ).rejects.toThrow(/only on open matters/);
      await expect(addChange(task.id, 'assignment', partner.id, { assignedTo: partner.id })).rejects.toThrow(/only on open matters/);
      await expect(addChange(task.id, 'status', partner.id, { status: 'open' })).rejects.toThrow(/only on open matters/);
    });

    it('drops repeated values instead of recording false history', async () => {
      const task = await addTask();

      expect(await addChange(task.id, 'details', feeEarner.id, { title: 'Review draft contract', description: null, dueOn: null, priority: 'normal' })).toBeUndefined();
      expect(await addChange(task.id, 'assignment', feeEarner.id, { assignedTo: feeEarner.id })).toBeUndefined();
      expect(await addChange(task.id, 'status', feeEarner.id, { status: 'open' })).toBeUndefined();
    });

    it('keeps change rows immutable even for the owner', async () => {
      const task = await addTask();
      const change = await addChange(task.id, 'status', feeEarner.id, { status: 'completed' });

      await expect(sql`update task_changes set to_status = 'cancelled' where id = ${change!.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
      await expect(sql`delete from task_changes where id = ${change!.id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
    });

    it('does not let the app supply history, and overwrites an owner-supplied before value', async () => {
      const task = await addTask();
      const appInsert = sql`
        insert into task_changes (task_id, kind, from_status, to_status, changed_by)
        values (${task.id}, 'status', 'cancelled', 'completed', ${feeEarner.id})
      `.execute(db);
      await expect(appInsert).rejects.toThrow(/permission denied/);

      const ownerInsert = await sql<{ from_status: string }>`
        insert into task_changes (task_id, kind, from_status, to_status, changed_by)
        values (${task.id}, 'status', 'cancelled', 'completed', ${feeEarner.id})
        returning from_status
      `.execute(ownerDb);
      expect(ownerInsert.rows[0]?.from_status).toBe('open');
    });

    it('refuses a change carrying fields for another kind', async () => {
      const task = await addTask();

      await expect(
        sql`
          insert into task_changes (task_id, kind, to_assigned_to, to_status, changed_by)
          values (${task.id}, 'assignment', ${partner.id}, 'completed', ${feeEarner.id})
        `.execute(db),
      ).rejects.toThrow(/assignee only/);
    });
  });

  describe('matter closure', () => {
    it('refuses closure while any task is open', async () => {
      await addTask();

      await expect(
        db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute(),
      ).rejects.toThrow(/open tasks/);
    });

    it('allows closure once every task is completed or cancelled', async () => {
      const completed = await addTask();
      const cancelled = await addTask();
      await addChange(completed.id, 'status', feeEarner.id, { status: 'completed' });
      await addChange(cancelled.id, 'status', feeEarner.id, { status: 'cancelled' });

      await expect(
        db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute(),
      ).resolves.toBeDefined();
    });

    it('waits for a simultaneous completion, then closes', async () => {
      const task = await addTask();
      let changeStarted!: () => void;
      let finishChange!: () => void;
      const started = new Promise<void>((resolve) => (changeStarted = resolve));
      const finish = new Promise<void>((resolve) => (finishChange = resolve));
      const changing = ownerDb.transaction().execute(async (trx) => {
        await trx
          .insertInto('task_changes')
          .values({
            task_id: task.id,
            kind: 'status',
            to_title: null,
            to_description: null,
            to_due_on: null,
            to_priority: null,
            to_assigned_to: null,
            to_status: 'completed',
            changed_by: feeEarner.id,
          })
          .execute();
        changeStarted();
        await finish;
      });
      await started;

      const closing = db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();
      const early = await Promise.race([
        closing.then(
          () => 'finished',
          () => 'finished',
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(early).toBe('waiting');

      finishChange();
      await changing;
      await expect(closing).resolves.toBeDefined();
    });

    it('waits for a simultaneous reopening, then refuses closure', async () => {
      const task = await addTask();
      await addChange(task.id, 'status', feeEarner.id, { status: 'completed' });
      let changeStarted!: () => void;
      let finishChange!: () => void;
      const started = new Promise<void>((resolve) => (changeStarted = resolve));
      const finish = new Promise<void>((resolve) => (finishChange = resolve));
      const changing = ownerDb.transaction().execute(async (trx) => {
        await trx
          .insertInto('task_changes')
          .values({
            task_id: task.id,
            kind: 'status',
            to_title: null,
            to_description: null,
            to_due_on: null,
            to_priority: null,
            to_assigned_to: null,
            to_status: 'open',
            changed_by: feeEarner.id,
          })
          .execute();
        changeStarted();
        await finish;
      });
      await started;

      const closing = db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work completed and final letter sent' }).execute();
      const early = await Promise.race([
        closing.then(
          () => 'finished',
          () => 'finished',
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ]);
      expect(early).toBe('waiting');

      finishChange();
      await changing;
      await expect(closing).rejects.toThrow(/open tasks/);
    });
  });
});
