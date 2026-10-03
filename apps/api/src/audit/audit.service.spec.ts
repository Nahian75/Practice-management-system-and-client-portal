import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv, testOwnerDatabaseUrl } from '../../test/database.js';
import { ConfigModule } from '../config/config.module.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { AuditEvent } from './audit-event.js';
import { AuditModule } from './audit.module.js';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  let audit: AuditService;
  let appDb: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let closeModule: () => Promise<void>;

  const signInFailed = (actorId: string = randomUUID()): AuditEvent => ({
    actor: { type: 'user', id: actorId },
    action: 'auth.sign_in_failed',
    outcome: 'denied',
  });

  const eventsFor = (actorId: string) =>
    appDb.selectFrom('audit_events').selectAll().where('actor_id', '=', actorId).execute();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(testEnv()), AuditModule],
    }).compile();
    await moduleRef.init();

    audit = moduleRef.get(AuditService);
    appDb = moduleRef.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    closeModule = () => moduleRef.close();
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await closeModule();
  });

  describe('recording', () => {
    it('stores every field of the event', async () => {
      const actorId = randomUUID();

      await audit.record({
        actor: { type: 'user', id: actorId },
        action: 'matter.viewed',
        outcome: 'success',
        resource: { type: 'matter', id: 'M-2026-0042' },
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        metadata: { via: 'portal' },
      });

      expect(await eventsFor(actorId)).toEqual([
        expect.objectContaining({
          actor_type: 'user',
          action: 'matter.viewed',
          outcome: 'success',
          resource_type: 'matter',
          resource_id: 'M-2026-0042',
          ip_address: '203.0.113.7',
          user_agent: 'Mozilla/5.0',
          metadata: { via: 'portal' },
        }),
      ]);
    });

    it('lets the database set the id and the time', async () => {
      const actorId = randomUUID();
      const before = Date.now();

      await audit.record(signInFailed(actorId));

      const [event] = await eventsFor(actorId);
      expect(event?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(event?.occurred_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('records system actions without an actor id', async () => {
      await expect(
        audit.record({ actor: { type: 'system' }, action: 'security.key_rotated', outcome: 'success' }),
      ).resolves.toBeUndefined();
    });

    it('truncates an oversized user agent instead of failing', async () => {
      const actorId = randomUUID();

      await audit.record({ ...signInFailed(actorId), userAgent: 'x'.repeat(10_000) });

      const [event] = await eventsFor(actorId);
      expect(event?.user_agent).toHaveLength(512);
    });

    it('is rolled back together with the transaction it was recorded in', async () => {
      const actorId = randomUUID();

      await expect(
        appDb.transaction().execute(async (trx) => {
          await audit.record(signInFailed(actorId), trx);
          throw new Error('the business change failed');
        }),
      ).rejects.toThrow('the business change failed');

      expect(await eventsFor(actorId)).toEqual([]);
    });
  });

  describe('rejects malformed events', () => {
    it.each<[string, AuditEvent]>([
      ['an action without a domain', { ...signInFailed(), action: 'signin' }],
      ['an action with capitals', { ...signInFailed(), action: 'Auth.SignIn' }],
      ['an action with spaces', { ...signInFailed(), action: 'auth.sign in' }],
      ['an unknown outcome', { ...signInFailed(), outcome: 'maybe' as AuditEvent['outcome'] }],
      ['a user actor without an id', { ...signInFailed(), actor: { type: 'user' } as AuditEvent['actor'] }],
      ['a badly formatted resource type', { ...signInFailed(), resource: { type: 'Matter!', id: '1' } }],
      ['an invalid IP address', { ...signInFailed(), ipAddress: 'not-an-ip' }],
      ['metadata over 4 KB', { ...signInFailed(), metadata: { note: 'x'.repeat(5000) } }],
    ])('%s', async (_case, event) => {
      await expect(audit.record(event)).rejects.toThrow();
    });
  });

  describe('is append-only', () => {
    let existingId: string;

    const attempts = (id: string) => ({
      UPDATE: sql`update audit_events set outcome = 'success' where id = ${id}`,
      DELETE: sql`delete from audit_events where id = ${id}`,
      TRUNCATE: sql`truncate audit_events`,
    });

    beforeAll(async () => {
      const actorId = randomUUID();
      await audit.record(signInFailed(actorId));
      const [event] = await eventsFor(actorId);
      existingId = event!.id;
    });

    it.each(['UPDATE', 'DELETE', 'TRUNCATE'] as const)('the app role cannot %s', async (operation) => {
      await expect(attempts(existingId)[operation].execute(appDb)).rejects.toThrow(/permission denied/);
    });

    it.each(['UPDATE', 'DELETE', 'TRUNCATE'] as const)('even the table owner cannot %s', async (operation) => {
      await expect(attempts(existingId)[operation].execute(ownerDb)).rejects.toThrow(
        `audit_events is append-only: ${operation} is not allowed`,
      );
    });

    it('the app role cannot backdate an entry', async () => {
      await expect(
        sql`insert into audit_events (occurred_at, actor_type, action, outcome)
            values ('2000-01-01', 'system', 'test.backdated', 'success')`.execute(appDb),
      ).rejects.toThrow(/permission denied/);
    });

    it('the app role cannot choose an entry id', async () => {
      await expect(
        sql`insert into audit_events (id, actor_type, action, outcome)
            values (${randomUUID()}, 'system', 'test.chosen_id', 'success')`.execute(appDb),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
