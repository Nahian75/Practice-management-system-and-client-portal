import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { inbox } from '../../../test/mailpit.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import { AuditService } from '../audit.service.js';
import { verifyAuditChain } from './audit-chain-verifier.js';
import { AuditChainModule } from './audit-chain.module.js';
import { AuditChainService } from './audit-chain.service.js';

describe('Audit chain', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let chain: AuditChainService;

  // A date no other run has used: checkpoints are once per day for the whole database.
  const unusedDate = () => `${randomInt(1000, 2999)}-0${randomInt(1, 10)}-1${randomInt(0, 10)}`;
  const recordEvent = () =>
    app.get(AuditService).record({ actor: { type: 'system' }, action: 'test.chain_event', outcome: 'success', metadata: { marker: randomUUID() } });

  beforeAll(async () => {
    app = await createTestApp(AuditChainModule);
    db = app.get(DATABASE);
    chain = app.get(AuditChainService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('seals each new event once, in a chain the check script accepts', async () => {
    const before = await db.selectFrom('audit_seals').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirstOrThrow();
    await recordEvent();
    await recordEvent();

    // Other test files write events meanwhile, so only these two are counted.
    expect(await chain.seal()).toBeGreaterThanOrEqual(2);
    await chain.seal();
    const ours = await db
      .selectFrom('audit_seals')
      .innerJoin('audit_events', 'audit_events.id', 'audit_seals.event_id')
      .select('audit_seals.seq')
      .where('audit_events.action', '=', 'test.chain_event')
      .where('audit_seals.seq', '>', before.seq ?? '0')
      .execute();
    expect(ours).toHaveLength(2);
    const report = await verifyAuditChain(db, []);
    expect(report.problems).toEqual([]);
    expect(report.unsealed).toBe(0);
    expect(report.head).toBeDefined();
  });

  it('accepts a checkpoint from the chain, and reports one the chain no longer matches or has lost', async () => {
    await recordEvent();
    await chain.seal();
    const head = (await verifyAuditChain(db, [])).head;
    if (!head) throw new Error('no seals');
    const forged = { seq: head.seq, hash: 'ab'.repeat(32) };
    const beyond = { seq: String(BigInt(head.seq) + 1_000_000n), hash: head.hash };

    expect((await verifyAuditChain(db, [head])).brokenCheckpoints).toEqual([]);
    expect((await verifyAuditChain(db, [forged, beyond])).brokenCheckpoints).toEqual([forged, beyond]);
  });

  it("emails the day's checkpoint to compliance holders once, in the same transaction as its record", async () => {
    const officer = await createTestAccount(db, 'staff');
    await grantTestRole(db, officer.id, 'compliance');
    const day = unusedDate();
    await recordEvent();

    expect(await chain.checkpoint(day)).toBe(true);
    expect(await chain.checkpoint(day)).toBe(false);
    const recorded = await db.selectFrom('audit_checkpoints').select(['seq', 'hash']).where('london_date', '=', day).executeTakeFirstOrThrow();
    await app.get(MailOutbox).drain();
    const emails = (await inbox(officer.email)).filter((email) => email.subject === `Audit log checkpoint for ${day}`);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.text).toContain(`--checkpoint ${recorded.seq}:${recorded.hash.toString('hex')}`);
  });

  it('keeps seals and checkpoints as they were', async () => {
    await recordEvent();
    await chain.seal();

    await expect(sql`update app.audit_seals set hash = hash`.execute(db)).rejects.toThrow();
    await expect(sql`delete from app.audit_checkpoints`.execute(db)).rejects.toThrow();
    await expect(sql`truncate app.audit_seals`.execute(db)).rejects.toThrow();
  });
});
