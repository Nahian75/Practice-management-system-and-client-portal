import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testEnv } from '../../test/database.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { createDatabase } from '../database/database.js';
import type { Database, EmailKind } from '../database/schema.js';
import { MailCipher } from '../mail/mail-cipher.js';
import { MailOutboxRepository } from '../mail/mail-outbox.repository.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import type { Mailer } from '../mail/mailer.js';
import { NotificationsRepository } from './notifications.repository.js';
import { TaskMailService } from './task-mail.service.js';
import { TaskReminderService } from './task-reminder.service.js';

const TEST_KEY = Buffer.alloc(32, 11);

describe('task reminder service', () => {
  let db: Kysely<Database>;
  let creator: TestAccount;
  let assignee: TestAccount;
  let matterId: string;
  let startsOn: string;
  let reminders: TaskReminderService;
  let cipher: MailCipher;
  let policy: MailOutboxRepository;

  const uniqueName = () => {
    const letters = Array.from(randomBytes(16), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
    return letters[0]!.toUpperCase() + letters.slice(1);
  };

  async function staff(role: 'partner' | 'fee_earner' = 'fee_earner'): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    await grantTestRole(db, account.id, role);
    return account;
  }

  async function openMatter(): Promise<void> {
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
    matterId = await db.transaction().execute(async (trx) => {
      const matter = await trx.insertInto('matters').values({
        client_id: client.id,
        title: 'Private reminder matter',
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

  async function addTask(recipient = assignee.id): Promise<string> {
    return (await db.insertInto('tasks').values({
      matter_id: matterId,
      title: 'Secret acquisition advice',
      description: 'Private instructions from the client',
      due_on: startsOn,
      priority: 'urgent',
      assigned_to: recipient,
      created_by: creator.id,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    const audit = new AuditService(new AuditRepository(db));
    cipher = new MailCipher(TEST_KEY, 1);
    policy = new MailOutboxRepository(db);
    const outbox = new MailOutbox(
      policy,
      cipher,
      { send: vi.fn() } as Mailer,
      audit,
    );
    reminders = new TaskReminderService(
      new NotificationsRepository(db),
      audit,
      new TaskMailService(outbox, testEnv()),
    );
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    startsOn = (await sql<{ starts_on: string }>`select starts_on::text from notification_reminder_settings`.execute(db)).rows[0]!.starts_on;
    creator = await staff();
    assignee = await staff('partner');
    await openMatter();
  });

  it('audits and queues one encrypted generic email in the reminder transaction', async () => {
    const taskId = await addTask();

    expect(await reminders.run(startsOn)).toBeGreaterThanOrEqual(1);

    const notification = await db.selectFrom('notifications').selectAll()
      .where('task_id', '=', taskId).where('kind', '=', 'task_due_today').executeTakeFirstOrThrow();
    const queued = await db.selectFrom('email_outbox').selectAll()
      .where('kind', '=', 'task_reminder').where('resource_id', '=', taskId).executeTakeFirstOrThrow();
    expect(JSON.stringify(queued)).not.toContain(assignee.email);
    expect(JSON.stringify(queued)).not.toContain('Secret acquisition advice');
    const message = cipher.open({
      keyVersion: queued.key_version!,
      nonce: queued.nonce!,
      ciphertext: queued.ciphertext!,
      authTag: queued.auth_tag!,
    }, {
      kind: queued.kind as EmailKind,
      recipientAccountId: queued.recipient_account_id,
      resourceType: queued.resource_type,
      resourceId: queued.resource_id,
    });
    expect(message.to).toBe(assignee.email);
    expect(message.text).toContain(`/tasks/${taskId}`);
    expect(JSON.stringify(message)).not.toMatch(/Secret acquisition advice|Private instructions|Private reminder matter|urgent|\d{4}-\d{2}-\d{2}/);
    expect(await db.selectFrom('audit_events').select(['action', 'resource_id', 'metadata'])
      .where('resource_id', 'in', [notification.id, queued.id]).orderBy('id').execute()).toEqual([
      expect.objectContaining({ action: 'notification.created', resource_id: notification.id }),
      expect.objectContaining({ action: 'email.queued', resource_id: queued.id }),
    ]);
    expect(await reminders.run(startsOn)).toBe(0);
  });

  it('rolls the notification and email back when their audit cannot be recorded', async () => {
    const taskId = await addTask();
    const audit = {
      record: vi.fn(async (event: { action: string }) => {
        if (event.action === 'notification.created') {
          throw new Error('audit unavailable');
        }
      }),
    } as unknown as AuditService;
    const outbox = new MailOutbox(
      new MailOutboxRepository(db),
      cipher,
      { send: vi.fn() } as Mailer,
      audit,
    );
    const failing = new TaskReminderService(
      new NotificationsRepository(db),
      audit,
      new TaskMailService(outbox, testEnv()),
    );

    await expect(failing.run(startsOn)).rejects.toThrow('audit unavailable');
    expect(await db.selectFrom('notifications').select('id')
      .where('task_id', '=', taskId).where('kind', '=', 'task_due_today').execute()).toEqual([]);
    expect(await db.selectFrom('email_outbox').select('id')
      .where('resource_id', '=', taskId).where('kind', '=', 'task_reminder').execute()).toEqual([]);
  });

  it('recognises assignment and reminder email that is still current', async () => {
    const taskId = await addTask();

    expect(await policy.taskEmailIsCurrent({
      kind: 'task_assignment',
      recipientAccountId: assignee.id,
      resourceType: 'task',
      resourceId: taskId,
      deduplicationKey: `task-email:assignment:${taskId}`,
    }, assignee.email)).toBe(true);
    expect(await policy.taskEmailIsCurrent({
      kind: 'task_reminder',
      recipientAccountId: assignee.id,
      resourceType: 'task',
      resourceId: taskId,
      deduplicationKey: `task-email:reminder:${taskId}:${startsOn}:today:${assignee.id}`,
    }, assignee.email)).toBe(true);
  });

  it('rejects stale task email after due-date, assignment, status, team or account changes', async () => {
    const dueChanged = await addTask();
    const reassigned = await addTask();
    const completed = await addTask();
    const next = await staff();
    const removedAssignee = await staff();
    const disabledAssignee = await staff();
    await db.insertInto('matter_team').values([next, removedAssignee, disabledAssignee].map((account) => ({
      matter_id: matterId,
      account_id: account.id,
      role: 'fee_earner' as const,
      added_by: creator.id,
    }))).execute();
    const removed = await addTask(removedAssignee.id);
    const disabled = await addTask(disabledAssignee.id);
    await db.insertInto('task_changes').values({
      task_id: dueChanged,
      kind: 'details',
      to_title: 'Secret acquisition advice',
      to_description: 'Private instructions from the client',
      to_due_on: null,
      to_priority: 'urgent',
      changed_by: creator.id,
    }).execute();
    await db.insertInto('task_changes').values({
      task_id: reassigned,
      kind: 'assignment',
      to_assigned_to: next.id,
      changed_by: creator.id,
    }).execute();
    await db.insertInto('task_changes').values({
      task_id: completed,
      kind: 'status',
      to_status: 'completed',
      changed_by: assignee.id,
    }).execute();
    await db.updateTable('matter_team').set({ removed_at: new Date(), removed_by: creator.id })
      .where('matter_id', '=', matterId).where('account_id', '=', removedAssignee.id).execute();
    await setAccountStatus(db, disabledAssignee.id, 'disabled');

    const assignment = (taskId: string, recipientId = assignee.id) => ({
      kind: 'task_assignment' as const,
      recipientAccountId: recipientId,
      resourceType: 'task',
      resourceId: taskId,
      deduplicationKey: `task-email:assignment:${taskId}`,
    });
    const reminder = (taskId: string) => ({
      kind: 'task_reminder' as const,
      recipientAccountId: assignee.id,
      resourceType: 'task',
      resourceId: taskId,
      deduplicationKey: `task-email:reminder:${taskId}:${startsOn}:today:${assignee.id}`,
    });

    expect(await policy.taskEmailIsCurrent(reminder(dueChanged), assignee.email)).toBe(false);
    expect(await policy.taskEmailIsCurrent(assignment(reassigned), assignee.email)).toBe(false);
    expect(await policy.taskEmailIsCurrent(assignment(completed), assignee.email)).toBe(false);
    expect(await policy.taskEmailIsCurrent(assignment(removed, removedAssignee.id), removedAssignee.email)).toBe(false);
    expect(await policy.taskEmailIsCurrent(assignment(disabled, disabledAssignee.id), disabledAssignee.email)).toBe(false);
    expect(await policy.taskEmailIsCurrent(assignment(await addTask()), 'different@example.com')).toBe(false);
  });
});
