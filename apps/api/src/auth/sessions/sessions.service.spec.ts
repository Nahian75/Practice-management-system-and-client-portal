import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, setAccountStatus, type TestAccount } from '../../../test/accounts.js';
import { testEnv } from '../../../test/database.js';
import { FakeClock, HOUR_MS, MINUTE_MS } from '../../../test/fake-clock.js';
import { CLOCK } from '../../common/time/clock.js';
import { ConfigModule } from '../../config/config.module.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { AuthModule } from '../auth.module.js';
import { hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import { SessionsService } from './sessions.service.js';

const CONTEXT = { ipAddress: '198.51.100.20', userAgent: 'Vitest' };

describe('SessionsService', () => {
  const clock = new FakeClock();
  let sessions: SessionsService;
  let db: Kysely<Database>;
  let close: () => Promise<void>;
  let staff: TestAccount;
  let client: TestAccount;

  const sessionRow = (token: string) =>
    db.selectFrom('sessions').selectAll().where('token_hash', '=', hashOpaqueToken(token)).executeTakeFirstOrThrow();
  const auditActions = (accountId: string) =>
    db
      .selectFrom('audit_events')
      .select('action')
      .where('actor_id', '=', accountId)
      .orderBy('occurred_at')
      .execute()
      .then((rows) => rows.map((row) => row.action));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(testEnv()), AuthModule],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    await moduleRef.init();
    sessions = moduleRef.get(SessionsService);
    db = moduleRef.get(DATABASE);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    clock.reset();
    staff = await createTestAccount(db, 'staff');
    client = await createTestAccount(db, 'client');
  });

  describe('start', () => {
    it('returns a token and stores only its hash', async () => {
      const token = await sessions.start(staff, 'authenticated', CONTEXT);
      const row = await sessionRow(token);

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.token_hash.equals(hashOpaqueToken(token))).toBe(true);
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('gives every session a different token', async () => {
      const first = await sessions.start(staff, 'authenticated', CONTEXT);
      const second = await sessions.start(staff, 'authenticated', CONTEXT);

      expect(first).not.toBe(second);
    });

    it.each([
      ['staff', 10 * HOUR_MS],
      ['client', 2 * HOUR_MS],
    ] as const)('sets the absolute limit for %s', async (kind, lifetime) => {
      const token = await sessions.start(kind === 'staff' ? staff : client, 'authenticated', CONTEXT);

      expect((await sessionRow(token)).expires_at.getTime()).toBe(clock.now().getTime() + lifetime);
    });

    it('gives a 2FA-pending session only five minutes', async () => {
      const token = await sessions.start(staff, 'two_factor_pending', CONTEXT);

      expect((await sessionRow(token)).expires_at.getTime()).toBe(clock.now().getTime() + 5 * MINUTE_MS);
    });
  });

  describe('resolve', () => {
    it('returns the session and its account', async () => {
      const token = await sessions.start(client, 'authenticated', CONTEXT);

      expect(await sessions.resolve(token)).toEqual({
        sessionId: expect.any(String),
        stage: 'authenticated',
        account: { id: client.id, kind: 'client', displayName: 'Test client' },
      });
    });

    it('returns nothing for a missing or unknown token', async () => {
      expect(await sessions.resolve(undefined)).toBeUndefined();
      expect(await sessions.resolve('A'.repeat(43))).toBeUndefined();
    });

    it.each([
      ['staff', 29 * MINUTE_MS, 30 * MINUTE_MS],
      ['client', 14 * MINUTE_MS, 15 * MINUTE_MS],
    ] as const)('ends a %s session after its idle limit', async (kind, stillOk, tooLong) => {
      const account = kind === 'staff' ? staff : client;
      const token = await sessions.start(account, 'authenticated', CONTEXT);

      clock.advance(stillOk);
      expect(await sessions.resolve(token)).toBeDefined();

      clock.advance(tooLong);
      expect(await sessions.resolve(token)).toBeUndefined();
      expect((await sessionRow(token)).end_reason).toBe('expired');
      expect(await auditActions(account.id)).toContain('auth.session_expired');
    });

    it('keeps an active session alive, but never past its absolute limit', async () => {
      const token = await sessions.start(client, 'authenticated', CONTEXT);

      for (let elapsed = 0; elapsed < 2 * HOUR_MS - 10 * MINUTE_MS; elapsed += 10 * MINUTE_MS) {
        clock.advance(10 * MINUTE_MS);
        expect(await sessions.resolve(token)).toBeDefined();
      }
      clock.advance(10 * MINUTE_MS);

      expect(await sessions.resolve(token)).toBeUndefined();
    });

    it('stays ended once expired, even if the clock goes back', async () => {
      const token = await sessions.start(client, 'authenticated', CONTEXT);
      clock.advance(3 * HOUR_MS);
      await sessions.resolve(token);

      clock.reset();
      expect(await sessions.resolve(token)).toBeUndefined();
    });

    it('ends a pending 2FA session after five minutes', async () => {
      const token = await sessions.start(staff, 'two_factor_pending', CONTEXT);

      clock.advance(5 * MINUTE_MS);

      expect(await sessions.resolve(token)).toBeUndefined();
    });

    it.each(['disabled', 'invited'] as const)('refuses and ends the session of a %s account', async (status) => {
      const token = await sessions.start(staff, 'authenticated', CONTEXT);

      await setAccountStatus(db, staff.id, status);

      expect(await sessions.resolve(token)).toBeUndefined();
      expect((await sessionRow(token)).end_reason).toBe('revoked');
    });

    it('records activity at most once a minute', async () => {
      const token = await sessions.start(client, 'authenticated', CONTEXT);
      const started = (await sessionRow(token)).last_seen_at;

      clock.advance(30_000);
      await sessions.resolve(token);
      expect((await sessionRow(token)).last_seen_at).toEqual(started);

      clock.advance(31_000);
      await sessions.resolve(token);
      expect((await sessionRow(token)).last_seen_at).toEqual(clock.now());
    });
  });

  describe('signOut', () => {
    it('ends the session and records it', async () => {
      const token = await sessions.start(client, 'authenticated', CONTEXT);

      await sessions.signOut(token, CONTEXT);

      expect(await sessions.resolve(token)).toBeUndefined();
      expect((await sessionRow(token)).end_reason).toBe('signed_out');
      expect(await auditActions(client.id)).toContain('auth.signed_out');
    });

    it('also ends a session that is still waiting for 2FA', async () => {
      const token = await sessions.start(client, 'two_factor_pending', CONTEXT);

      await sessions.signOut(token, CONTEXT);

      expect((await sessionRow(token)).end_reason).toBe('signed_out');
    });

    it('does nothing without a session', async () => {
      await expect(sessions.signOut(undefined, CONTEXT)).resolves.toBeUndefined();
    });
  });
});
