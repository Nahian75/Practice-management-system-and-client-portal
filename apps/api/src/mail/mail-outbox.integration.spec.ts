import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testAppDatabaseUrl, testEnv } from '../../test/database.js';
import { waitForEmails } from '../../test/mailpit.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';
import { MailCipher } from './mail-cipher.js';
import { MailOutbox } from './mail-outbox.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { SmtpMailer, type Mailer } from './mailer.js';

const TEST_KEY = Buffer.alloc(32, 11);

describe('persistent email outbox', () => {
  let db: Kysely<Database>;
  let repository: MailOutboxRepository;
  let audit: AuditService;
  let cipher: MailCipher;

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    repository = new MailOutboxRepository(db);
    audit = new AuditService(new AuditRepository(db));
    cipher = new MailCipher(TEST_KEY, 1);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('stores no readable message data and deduplicates retries', async () => {
    const marker = randomUUID();
    const deduplicationMarker = randomUUID();
    const message = {
      to: `private-${marker}@example.com`,
      subject: `Private subject ${marker}`,
      text: `Private body and token ${marker}`,
    };
    const outbox = new MailOutbox(repository, cipher, { send: vi.fn() } as Mailer, audit);
    const options = {
      kind: 'security_notice' as const,
      deduplicationKey: `integration:${deduplicationMarker}`,
      notBefore: new Date(Date.now() + 23 * 60 * 60_000),
    };

    const first = await outbox.enqueue(message, options);
    const repeated = await outbox.enqueue(message, options);

    expect(repeated).toBe(first);
    const row = await db.selectFrom('email_outbox').selectAll().where('id', '=', first).executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'pending',
      key_version: 1,
      nonce: expect.any(Buffer),
      ciphertext: expect.any(Buffer),
      auth_tag: expect.any(Buffer),
    });
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(
      await db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('action', '=', 'email.queued')
        .where('resource_id', '=', first)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: '1' });
  });

  it('delivers a row created by an earlier outbox instance and clears its payload', async () => {
    const address = `restart-${randomUUID()}@example.com`;
    const message = { to: address, subject: 'Persistent delivery', text: 'This survives an API restart.' };
    const neverUsed = { send: vi.fn() } as Mailer;
    const firstInstance = new MailOutbox(repository, cipher, neverUsed, audit);
    const id = await firstInstance.enqueue(message, {
      kind: 'security_notice',
      deduplicationKey: `restart:${address}`,
    });

    const smtp = new SmtpMailer(testEnv());
    const restartedInstance = new MailOutbox(repository, cipher, smtp, audit);
    await restartedInstance.drain();
    expect(await waitForEmails(address, 1)).toEqual([
      expect.objectContaining({ subject: message.subject, text: `${message.text}\r\n` }),
    ]);
    expect(neverUsed.send).not.toHaveBeenCalled();

    const delivered = await db.selectFrom('email_outbox').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(delivered).toMatchObject({
      status: 'sent',
      key_version: null,
      nonce: null,
      ciphertext: null,
      auth_tag: null,
      completed_at: expect.any(Date),
    });
    const auditActions = await db
      .selectFrom('audit_events')
      .select(['action', 'metadata'])
      .where('resource_id', '=', id)
      .orderBy('id')
      .execute();
    expect(auditActions.map((event) => event.action)).toEqual(['email.queued', 'email.sent']);
    expect(JSON.stringify(auditActions)).not.toContain(address);
    expect(JSON.stringify(auditActions)).not.toContain(message.text);
    smtp.onApplicationShutdown();
  });
});
