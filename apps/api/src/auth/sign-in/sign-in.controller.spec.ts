import { argon2Sync, randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, setAccountStatus, type TestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { FakeClock, MINUTE_MS } from '../../../test/fake-clock.js';
import { inbox } from '../../../test/mailpit.js';
import { enrolTwoFactor } from '../../../test/two-factor.js';
import { DATABASE } from '../../database/database.module.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import type { Database } from '../../database/schema.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { MAX_GUESSES } from './sign-in-limits.js';

const PASSWORD = 'tidy-otter-quartz-lantern';
const WRONG = 'tidy-otter-quartz-lanterns';
const REJECTION = { statusCode: 401, message: 'Email or password is incorrect' };

@Module({})
class EmptyModule {}

function weakerArgon2idHash(password: string): string {
  const salt = randomBytes(16);
  const hash = argon2Sync('argon2id', { message: password, nonce: salt, memory: 9216, passes: 1, parallelism: 1, tagLength: 32 });
  const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=9216,t=1,p=1$${b64(salt)}$${b64(hash)}`;
}

describe('POST /auth/sign-in', () => {
  const clock = new FakeClock();
  let app: INestApplication;
  let db: Kysely<Database>;
  let hasher: PasswordHasher;
  let passwordHash: string;
  let staff: TestAccount;

  const signIn = (email: string, password: string) =>
    request(app.getHttpServer()).post('/auth/sign-in').send({ email, password });

  const sessionCookie = (response: request.Response) =>
    ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((c) => c.startsWith('__Host-session=') && !c.includes('Max-Age=0'));

  const tokenFrom = (response: request.Response) => sessionCookie(response)?.split(';')[0]?.split('=')[1];

  const auditFor = (accountId: string) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'outcome', 'metadata'])
      .where('actor_id', '=', accountId)
      .where('action', '!=', 'auth.two_factor_enrolled')
      .orderBy('occurred_at')
      .execute();

  /** An active account with a known password and 2FA set up: able to sign in. */
  async function readyAccount(kind: 'staff' | 'client', hash = passwordHash): Promise<TestAccount> {
    const account = await createTestAccount(db, kind, { passwordHash: hash });
    await enrolTwoFactor(app.get(TwoFactorService), account, clock);
    return account;
  }

  async function failTimes(email: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      expect((await signIn(email, WRONG)).status).toBe(401);
    }
  }

  beforeAll(async () => {
    app = await createTestApp(EmptyModule, { clock });
    db = app.get(DATABASE);
    hasher = app.get(PasswordHasher);
    passwordHash = await hasher.hash(PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.reset();
    staff = await readyAccount('staff');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with the right password', () => {
    it('asks for the 2FA code and sets a session cookie', async () => {
      const response = await signIn(staff.email, PASSWORD);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ next: 'two_factor' });
      expect(sessionCookie(response)).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    });

    it('creates a session that cannot be used until the 2FA code is entered', async () => {
      const token = tokenFrom(await signIn(staff.email, PASSWORD));

      const session = await db
        .selectFrom('sessions')
        .select('stage')
        .where('token_hash', '=', hashOpaqueToken(token!))
        .executeTakeFirstOrThrow();
      const protectedRoute = await request(app.getHttpServer()).get('/auth/session').set('Cookie', `__Host-session=${token}`);

      expect(session.stage).toBe('two_factor_pending');
      expect(protectedRoute.status).toBe(401);
    });

    it('ignores case and surrounding spaces in the email', async () => {
      expect((await signIn(`  ${staff.email.toUpperCase()} `, PASSWORD)).status).toBe(200);
    });

    it('records the accepted password', async () => {
      await signIn(staff.email, PASSWORD);

      expect(await auditFor(staff.id)).toEqual([{ action: 'auth.password_accepted', outcome: 'success', metadata: {} }]);
    });

    it('ends any session the browser already had', async () => {
      const oldToken = await app.get(SessionsService).start(staff, 'authenticated', {});

      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set('Cookie', `__Host-session=${oldToken}`)
        .send({ email: staff.email, password: PASSWORD });

      expect(await app.get(SessionsService).resolve(oldToken)).toBeUndefined();
    });

    it('upgrades a password hash made with older, weaker settings', async () => {
      const legacy = await readyAccount('client', weakerArgon2idHash(PASSWORD));

      expect((await signIn(legacy.email, PASSWORD)).status).toBe(200);

      const { password_hash } = await db.selectFrom('accounts').select('password_hash').where('id', '=', legacy.id).executeTakeFirstOrThrow();
      expect(password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await hasher.verify(PASSWORD, password_hash!)).toBe(true);
    });
  });

  describe('every rejection looks the same', () => {
    it.each<[string, () => Promise<[string, string]>]>([
      ['a wrong password', async () => [staff.email, WRONG]],
      ['an unknown email', async () => [`nobody-${randomBytes(4).toString('hex')}@example.com`, PASSWORD]],
      ['an invited account with no password yet', async () => [(await createTestAccount(db, 'client', { status: 'invited' })).email, PASSWORD]],
      ['a disabled account, even with the right password', async () => {
        await setAccountStatus(db, staff.id, 'disabled');
        return [staff.email, PASSWORD];
      }],
      ['something that is not an email at all', async () => ['not-an-email', PASSWORD]],
      ['an active account that has not set up 2FA', async () => [(await createTestAccount(db, 'staff', { passwordHash })).email, PASSWORD]],
    ])('%s', async (_case, makeAttempt) => {
      const [email, password] = await makeAttempt();

      const response = await signIn(email, password);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(REJECTION);
      expect(sessionCookie(response)).toBeUndefined();
    });

    it('does the same password-hashing work for an unknown email', async () => {
      const verify = vi.spyOn(PasswordHasher.prototype, 'verify');

      await signIn(`nobody-${randomBytes(4).toString('hex')}@example.com`, PASSWORD);

      expect(verify).toHaveBeenCalledOnce();
    });

    it('records an unknown email without storing the email', async () => {
      const email = `nobody-${randomBytes(4).toString('hex')}@example.com`;

      await signIn(email, PASSWORD);

      const recent = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'auth.sign_in_failed')
        .where('actor_type', '=', 'anonymous')
        .orderBy('occurred_at', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      expect(recent.metadata).toEqual({ reason: 'unknown_account' });
      expect(JSON.stringify(recent)).not.toContain(email);
    });

    it('records a wrong password against the account', async () => {
      await signIn(staff.email, WRONG);

      expect(await auditFor(staff.id)).toEqual([
        { action: 'auth.sign_in_failed', outcome: 'denied', metadata: { reason: 'wrong_password' } },
      ]);
    });
  });

  describe('blocking after repeated wrong passwords', () => {
    it(`blocks the account after ${MAX_GUESSES} wrong passwords, even for the right one`, async () => {
      await failTimes(staff.email, MAX_GUESSES);

      const response = await signIn(staff.email, PASSWORD);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(REJECTION);
      expect((await auditFor(staff.id)).at(-1)).toEqual({
        action: 'auth.sign_in_blocked',
        outcome: 'denied',
        metadata: { reason: 'too_many_wrong_attempts' },
      });
    });

    it('emails the account holder once when the block starts', async () => {
      await failTimes(staff.email, MAX_GUESSES + 3);

      await app.get(MailOutbox).drain();
      const notices = (await inbox(staff.email)).filter((e) => e.subject === 'Sign-in to your account was blocked');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain('blocked for 15 minutes');
    });

    it('sends no block email before the limit is reached', async () => {
      await failTimes(staff.email, MAX_GUESSES - 1);

      await app.get(MailOutbox).drain();
      expect(await inbox(staff.email)).toEqual([]);
    });

    it('does not block one attempt early', async () => {
      await failTimes(staff.email, MAX_GUESSES - 1);

      expect((await signIn(staff.email, PASSWORD)).status).toBe(200);
    });

    it('lifts the block after 15 minutes', async () => {
      await failTimes(staff.email, MAX_GUESSES);

      clock.advance(15 * MINUTE_MS);

      expect((await signIn(staff.email, PASSWORD)).status).toBe(200);
    });

    it('does not let attempts during the block extend it', async () => {
      await failTimes(staff.email, MAX_GUESSES);
      clock.advance(10 * MINUTE_MS);
      await failTimes(staff.email, 5);

      clock.advance(5 * MINUTE_MS);

      expect((await signIn(staff.email, PASSWORD)).status).toBe(200);
    });

    it('only blocks the account under attack', async () => {
      const colleague = await readyAccount('staff');
      await failTimes(staff.email, MAX_GUESSES);

      expect((await signIn(colleague.email, PASSWORD)).status).toBe(200);
    });

    it('forgets wrong passwords made before the last completed sign-in', async () => {
      await failTimes(staff.email, MAX_GUESSES - 1);
      clock.advance(1_000);
      await app.get(SessionsService).start(staff, 'authenticated', {});
      clock.advance(1_000);

      await failTimes(staff.email, 1);

      expect((await signIn(staff.email, PASSWORD)).status).toBe(200);
    });
  });

  describe('input checks', () => {
    it.each([
      ['an unexpected field', { email: 'a@example.com', password: PASSWORD, remember: true }],
      ['no password', { email: 'a@example.com' }],
      ['an empty password', { email: 'a@example.com', password: '' }],
      ['an oversized password', { email: 'a@example.com', password: 'x'.repeat(1025) }],
      ['an oversized email', { email: `${'a'.repeat(250)}@example.com`, password: PASSWORD }],
      ['a password that is not text', { email: 'a@example.com', password: 12345678901234 }],
    ])('rejects %s with 400', async (_case, body) => {
      expect((await request(app.getHttpServer()).post('/auth/sign-in').send(body)).status).toBe(400);
    });

    it('cannot be submitted from another website', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ email: staff.email, password: PASSWORD });

      expect(response.status).toBe(403);
    });
  });
});
