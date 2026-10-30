import { createHash } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, setAccountStatus, type TestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { FakeClock, HOUR_MS, MINUTE_MS } from '../../../test/fake-clock.js';
import { inbox, waitForEmails } from '../../../test/mailpit.js';
import { authenticatorCode, enrolTwoFactor } from '../../../test/two-factor.js';
import { hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import { DATABASE } from '../../database/database.module.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import type { Database } from '../../database/schema.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TOTP_STEP_SECONDS } from '../two-factor/totp.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { MAX_RESETS_PER_HOUR } from './password-reset.service.js';

const OLD_PASSWORD = 'tidy-otter-quartz-lantern';
const NEW_PASSWORD = 'brisk-heron-copper-meadow';
const INVALID_LINK = { statusCode: 404, message: 'This reset link is invalid or has expired' };
const RESET_SUBJECT = 'Reset your Practice Portal password';

@Module({})
class EmptyModule {}

describe('Password reset', () => {
  const clock = new FakeClock();
  let app: INestApplication;
  let db: Kysely<Database>;
  let passwordHash: string;
  let account: TestAccount;
  let secret: string;

  const requestReset = (email: string) =>
    request(app.getHttpServer()).post('/auth/password-reset/request').send({ email });
  const completeReset = (token: string, password: string) =>
    request(app.getHttpServer()).post('/auth/password-reset/complete').send({ token, password });

  /** Every email queued so far has reached Mailpit. */
  const settle = () => app.get(MailOutbox).drain();

  const resetEmails = async (address: string) => (await inbox(address)).filter((e) => e.subject === RESET_SUBJECT);

  async function resetToken(address = account.email): Promise<string> {
    const before = (await resetEmails(address)).length;
    expect((await requestReset(address)).status).toBe(204);
    await settle();

    const emails = await resetEmails(address);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(emails.at(-1)?.text ?? '')?.[1];
    if (emails.length <= before || !token) {
      throw new Error('No new reset email arrived');
    }
    return token;
  }

  async function signInFully(password: string) {
    const step1 = await request(app.getHttpServer()).post('/auth/sign-in').send({ email: account.email, password });
    if (step1.status !== 200) {
      return step1.status;
    }
    const pending = /__Host-session=([^;]+)/.exec(String(step1.headers['set-cookie']))?.[1];
    const step2 = await request(app.getHttpServer())
      .post('/auth/two-factor')
      .set('Cookie', `__Host-session=${pending}`)
      .send({ code: authenticatorCode(secret, clock) });
    clock.advance(TOTP_STEP_SECONDS * 1000);
    return step2.status;
  }

  beforeAll(async () => {
    app = await createTestApp(EmptyModule, { clock });
    db = app.get(DATABASE);
    passwordHash = await app.get(PasswordHasher).hash(OLD_PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.reset();
    account = await createTestAccount(db, 'client', { passwordHash });
    secret = await enrolTwoFactor(app.get(TwoFactorService), account, clock);
  });

  describe('requesting', () => {
    it('emails a link with the token after #', async () => {
      await resetToken();

      const [email] = await resetEmails(account.email);
      expect(email?.text).toMatch(/http:\/\/localhost:3000\/reset-password#token=[A-Za-z0-9_-]{43}/);
      expect(email?.text).toContain('You will still need your authenticator app');
    });

    it('stores only a hash of the token', async () => {
      const token = await resetToken();

      const rows = await db.selectFrom('password_resets').selectAll().where('account_id', '=', account.id).execute();
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]?.token_hash.equals(hashOpaqueToken(token))).toBe(true);
    });

    it.each([
      ['an unknown email', async () => `nobody-${account.id}@example.com`],
      ['an invited account', async () => (await createTestAccount(db, 'client', { status: 'invited' })).email],
      ['a disabled account', async () => (await createTestAccount(db, 'client', { status: 'disabled' })).email],
    ])('answers %s exactly like a real one, and sends nothing', async (_case, makeEmail) => {
      const email = await makeEmail();

      const response = await requestReset(email);
      await settle();

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(await inbox(email)).toEqual([]);
    });

    it('records an unknown email without storing the address', async () => {
      const email = `nobody-${account.id}@example.com`;

      await requestReset(email);

      const event = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'auth.password_reset_requested')
        .where('actor_type', '=', 'anonymous')
        .orderBy('occurred_at', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(event.metadata).toEqual({ reason: 'unknown_account' });
      expect(JSON.stringify(event)).not.toContain(email);
    });

    it(`sends at most ${MAX_RESETS_PER_HOUR} emails an hour, so it cannot flood an inbox`, async () => {
      for (let i = 0; i < MAX_RESETS_PER_HOUR; i += 1) {
        await resetToken();
      }

      expect((await requestReset(account.email)).status).toBe(204);
      await settle();
      expect(await resetEmails(account.email)).toHaveLength(MAX_RESETS_PER_HOUR);

      clock.advance(HOUR_MS);
      await resetToken();
      expect(await resetEmails(account.email)).toHaveLength(MAX_RESETS_PER_HOUR + 1);
    });

    it('cancels the earlier link when a new one is requested', async () => {
      const first = await resetToken();
      await resetToken();

      expect((await completeReset(first, NEW_PASSWORD)).body).toEqual(INVALID_LINK);
    });
  });

  describe('completing', () => {
    it.each(['hash', 'revocation', 'notice'] as const)('preserves the link, password and sessions if %s fails', async (failure) => {
      const token = await resetToken();
      const sessions = app.get(SessionsService);
      const existing = await sessions.start(account, 'authenticated', {});
      const spy = failure === 'hash' ? vi.spyOn(app.get(PasswordHasher), 'hash').mockRejectedValueOnce(new Error('Injected failure')) :
        failure === 'revocation' ? vi.spyOn(sessions, 'endAllForAccount').mockRejectedValueOnce(new Error('Injected failure')) :
        vi.spyOn(app.get(MailOutbox), 'enqueueInTransaction').mockRejectedValueOnce(new Error('Injected failure'));
      try {
        expect((await completeReset(token, NEW_PASSWORD)).status).toBe(500);
        expect(await sessions.resolve(existing)).toBeDefined();
        const stored = await db.selectFrom('accounts').select('password_hash').where('id', '=', account.id).executeTakeFirstOrThrow();
        expect(await app.get(PasswordHasher).verify(OLD_PASSWORD, stored.password_hash!)).toBe(true);
        const reset = await db.selectFrom('password_resets').select('closed_at').where('token_hash', '=', hashOpaqueToken(token)).executeTakeFirstOrThrow();
        expect(reset.closed_at).toBeNull();
      } finally { spy.mockRestore(); }
      expect((await completeReset(token, NEW_PASSWORD)).status).toBe(204);
      expect(await sessions.resolve(existing)).toBeUndefined();
    });

    it('changes the password: the new one works and the old one does not', async () => {
      const token = await resetToken();

      expect((await completeReset(token, NEW_PASSWORD)).status).toBe(204);
      expect(await signInFully(NEW_PASSWORD)).toBe(200);
      expect(await signInFully(OLD_PASSWORD)).toBe(401);
    });

    it('still requires the authenticator code afterwards', async () => {
      await completeReset(await resetToken(), NEW_PASSWORD);

      const step1 = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email: account.email, password: NEW_PASSWORD });

      expect(step1.body).toEqual({ next: 'two_factor' });
    });

    it('signs out every existing session', async () => {
      const sessions = app.get(SessionsService);
      const laptop = await sessions.start(account, 'authenticated', {});
      const phone = await sessions.start(account, 'authenticated', {});

      await completeReset(await resetToken(), NEW_PASSWORD);

      expect(await sessions.resolve(laptop)).toBeUndefined();
      expect(await sessions.resolve(phone)).toBeUndefined();
    });

    it('emails the account holder that the password changed', async () => {
      await completeReset(await resetToken(), NEW_PASSWORD);

      const emails = await waitForEmails(account.email, 2);
      expect(emails.map((e) => e.subject)).toContain('Your password was changed');
    });

    it('works once only', async () => {
      const token = await resetToken();
      await completeReset(token, NEW_PASSWORD);

      expect((await completeReset(token, 'another-long-password-9')).body).toEqual(INVALID_LINK);
    });

    it('lets only one of two simultaneous uses of the same link succeed', async () => {
      const token = await resetToken();

      const results = await Promise.all([
        completeReset(token, NEW_PASSWORD),
        completeReset(token, 'another-long-password-9'),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
    });

    it('expires after 30 minutes', async () => {
      const token = await resetToken();

      clock.advance(30 * MINUTE_MS);

      expect((await completeReset(token, NEW_PASSWORD)).body).toEqual(INVALID_LINK);
    });

    it('stops working if the account is disabled in the meantime', async () => {
      const token = await resetToken();
      await setAccountStatus(db, account.id, 'disabled');

      expect((await completeReset(token, NEW_PASSWORD)).body).toEqual(INVALID_LINK);
    });

    it('rejects a weak password with a reason, and the link stays usable', async () => {
      const token = await resetToken();

      const weak = await completeReset(token, 'short');
      const strong = await completeReset(token, NEW_PASSWORD);

      expect(weak.body).toEqual({ statusCode: 400, message: ['Use at least 12 characters'] });
      expect(strong.status).toBe(204);
    });

    it('rejects a breached password', async () => {
      const breached = 'correct horse battery staple';
      const suffix = createHash('sha1').update(breached).digest('hex').toUpperCase().slice(5);
      const breachedApp = await createTestApp(EmptyModule, { clock, fetch: async () => new Response(`${suffix}:3812\r\n`) });
      try {
        const token = await resetToken();
        const response = await request(breachedApp.getHttpServer())
          .post('/auth/password-reset/complete')
          .send({ token, password: breached });

        expect(response.body.message).toEqual(['This password has appeared in a data breach. Choose a different one']);
      } finally {
        await breachedApp.close();
      }
    });

    it('records the reset and how many sessions it ended', async () => {
      await app.get(SessionsService).start(account, 'authenticated', {});

      await completeReset(await resetToken(), NEW_PASSWORD);

      const event = await db
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('actor_id', '=', account.id)
        .where('action', '=', 'auth.password_reset_completed')
        .executeTakeFirstOrThrow();
      expect(event.metadata).toEqual({ endedSessions: 1 });
    });
  });

  describe('input checks', () => {
    it.each([
      ['request with an extra field', 'request', { email: 'a@example.com', admin: true }],
      ['request with an oversized email', 'request', { email: `${'a'.repeat(250)}@example.com` }],
      ['complete with a malformed token', 'complete', { token: 'abc', password: NEW_PASSWORD }],
      ['complete without a password', 'complete', { token: 'A'.repeat(43) }],
    ])('rejects %s with 400', async (_case, path, body) => {
      expect((await request(app.getHttpServer()).post(`/auth/password-reset/${path}`).send(body)).status).toBe(400);
    });

    it('cannot be submitted from another website', async () => {
      const response = await requestReset(account.email).set('Sec-Fetch-Site', 'cross-site');

      expect(response.status).toBe(403);
    });
  });
});
