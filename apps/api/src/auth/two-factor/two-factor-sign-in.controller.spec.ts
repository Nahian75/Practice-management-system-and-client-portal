import { Module, type INestApplication } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../../test/database.js';
import { FakeClock, MINUTE_MS } from '../../../test/fake-clock.js';
import { authenticatorCode, enrolTwoFactor } from '../../../test/two-factor.js';
import { createDatabase } from '../../database/database.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { MAX_CODE_ATTEMPTS_PER_SIGN_IN, MAX_GUESSES } from '../sign-in/sign-in-limits.js';
import { BackupCodesService } from './backup-codes.service.js';
import { TOTP_STEP_SECONDS } from './totp.js';
import { TwoFactorService } from './two-factor.service.js';

const PASSWORD = 'tidy-otter-quartz-lantern';
const WRONG_CODE = { statusCode: 401, message: 'The code is incorrect' };
const SIGN_IN_AGAIN = { statusCode: 401, message: 'Please sign in again' };

@Module({})
class EmptyModule {}

describe('POST /auth/two-factor', () => {
  const clock = new FakeClock();
  let app: INestApplication;
  let db: Kysely<Database>;
  let passwordHash: string;
  let account: TestAccount;
  let secret: string;

  const cookieToken = (response: request.Response) =>
    ([] as string[])
      .concat(response.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('__Host-session=') && !c.includes('Max-Age=0'))
      ?.split(';')[0]
      ?.split('=')[1];

  const clearsCookie = (response: request.Response) =>
    ([] as string[]).concat(response.headers['set-cookie'] ?? []).some((c) => c.includes('Max-Age=0'));

  async function passwordStep(email = account.email, password = PASSWORD): Promise<string> {
    const response = await request(app.getHttpServer()).post('/auth/sign-in').send({ email, password });
    expect(response.status).toBe(200);
    return cookieToken(response)!;
  }

  const codeStep = (pendingToken: string | undefined, code: string) => {
    const call = request(app.getHttpServer()).post('/auth/two-factor').send({ code });
    return pendingToken ? call.set('Cookie', `__Host-session=${pendingToken}`) : call;
  };

  const currentSession = (token: string) =>
    request(app.getHttpServer()).get('/auth/session').set('Cookie', `__Host-session=${token}`);

  const currentCode = () => authenticatorCode(secret, clock);
  const wrongCode = () => String((Number(currentCode()) + 1) % 1_000_000).padStart(6, '0');

  const auditActions = (accountId: string) =>
    db
      .selectFrom('audit_events')
      .select(['action', 'metadata'])
      .where('actor_id', '=', accountId)
      .orderBy('occurred_at')
      .execute();

  /** Moves to the next 30-second window, so a fresh code is valid. */
  const nextWindow = () => clock.advance(TOTP_STEP_SECONDS * 1000);

  beforeAll(async () => {
    app = await createTestApp(EmptyModule, { clock });
    db = app.get(DATABASE);
    passwordHash = await app.get(PasswordHasher).hash(PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    clock.reset();
    account = await createTestAccount(db, 'staff', { passwordHash });
    secret = await enrolTwoFactor(app.get(TwoFactorService), account, clock);
  });

  describe('the full sign-in', () => {
    it('signs in with password then authenticator code', async () => {
      const pending = await passwordStep();

      const response = await codeStep(pending, currentCode());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ account: { id: account.id, kind: 'staff', displayName: 'Test staff' } });
    });

    it('issues a new token, and the token from the password step stops working', async () => {
      const pending = await passwordStep();

      const signedIn = cookieToken(await codeStep(pending, currentCode()))!;

      expect(signedIn).not.toBe(pending);
      expect((await currentSession(signedIn)).status).toBe(200);
      expect((await currentSession(pending)).status).toBe(401);
      expect((await codeStep(pending, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });

    it('works for client accounts too', async () => {
      const client = await createTestAccount(db, 'client', { passwordHash });
      const clientSecret = await enrolTwoFactor(app.get(TwoFactorService), client, clock);

      const pending = await passwordStep(client.email);
      const response = await codeStep(pending, authenticatorCode(clientSecret, clock));

      expect(response.status).toBe(200);
      expect(response.body.account.kind).toBe('client');
    });

    it('records the sign-in', async () => {
      await codeStep(await passwordStep(), currentCode());

      expect((await auditActions(account.id)).at(-1)).toEqual({
        action: 'auth.sign_in_succeeded',
        metadata: { method: 'authenticator' },
      });
    });
  });

  describe('wrong codes', () => {
    it('refuses a wrong code but lets the user try again', async () => {
      const pending = await passwordStep();

      expect((await codeStep(pending, wrongCode())).body).toEqual(WRONG_CODE);
      expect((await codeStep(pending, currentCode())).status).toBe(200);
    });

    it(`cancels the sign-in after ${MAX_CODE_ATTEMPTS_PER_SIGN_IN} wrong codes`, async () => {
      const pending = await passwordStep();
      for (let i = 1; i < MAX_CODE_ATTEMPTS_PER_SIGN_IN; i += 1) {
        expect((await codeStep(pending, wrongCode())).body).toEqual(WRONG_CODE);
      }

      const last = await codeStep(pending, wrongCode());

      expect(last.body).toEqual(SIGN_IN_AGAIN);
      expect(clearsCookie(last)).toBe(true);
      expect((await codeStep(pending, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });

    it('does not accept the same code twice, even across sign-ins', async () => {
      const code = currentCode();
      await codeStep(await passwordStep(), code);

      expect((await codeStep(await passwordStep(), code)).body).toEqual(WRONG_CODE);
    });

    it('counts wrong codes towards the account block, so new sign-ins do not reset the guessing', async () => {
      const attempts = Math.ceil(MAX_GUESSES / MAX_CODE_ATTEMPTS_PER_SIGN_IN);
      for (let round = 0; round < attempts; round += 1) {
        const pending = await passwordStep();
        for (let i = 0; i < MAX_CODE_ATTEMPTS_PER_SIGN_IN; i += 1) {
          await codeStep(pending, wrongCode());
        }
      }

      const blocked = await request(app.getHttpServer()).post('/auth/sign-in').send({ email: account.email, password: PASSWORD });

      expect(blocked.status).toBe(401);
    });

    it('cancels a waiting sign-in once the account is blocked', async () => {
      const pending = await passwordStep();
      for (let i = 0; i < MAX_GUESSES; i += 1) {
        await request(app.getHttpServer()).post('/auth/sign-in').send({ email: account.email, password: 'wrong-password-123' });
      }

      expect((await codeStep(pending, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });

    it('clears earlier wrong attempts once sign-in completes', async () => {
      for (let i = 0; i < MAX_GUESSES - 1; i += 1) {
        await request(app.getHttpServer()).post('/auth/sign-in').send({ email: account.email, password: 'wrong-password-123' });
      }
      clock.advance(1_000);
      await codeStep(await passwordStep(), currentCode());
      nextWindow();

      for (let i = 0; i < MAX_GUESSES - 1; i += 1) {
        await request(app.getHttpServer()).post('/auth/sign-in').send({ email: account.email, password: 'wrong-password-123' });
      }

      expect((await codeStep(await passwordStep(), currentCode())).status).toBe(200);
    });
  });

  describe('backup codes', () => {
    let backupCodes: string[];

    beforeEach(async () => {
      backupCodes = await app.get(BackupCodesService).issue(account);
    });

    it('signs in with a backup code, typed any way', async () => {
      const typed = backupCodes[0]!.toLowerCase().replaceAll('-', ' ');

      const response = await codeStep(await passwordStep(), typed);

      expect(response.status).toBe(200);
    });

    it('accepts each backup code only once', async () => {
      await codeStep(await passwordStep(), backupCodes[0]!);

      expect((await codeStep(await passwordStep(), backupCodes[0]!)).body).toEqual(WRONG_CODE);
    });

    it('records the use and how many codes are left', async () => {
      await codeStep(await passwordStep(), backupCodes[0]!);

      const actions = await auditActions(account.id);
      expect(actions.slice(-2)).toEqual([
        { action: 'auth.backup_code_used', metadata: { remaining: 9 } },
        { action: 'auth.sign_in_succeeded', metadata: { method: 'backup_code' } },
      ]);
    });

    it('does not accept another account backup code', async () => {
      const other = await createTestAccount(db, 'staff', { passwordHash });
      const [otherCode] = await app.get(BackupCodesService).issue(other);

      expect((await codeStep(await passwordStep(), otherCode!)).body).toEqual(WRONG_CODE);
    });

    it('retires old codes when a new set is issued', async () => {
      await app.get(BackupCodesService).issue(account);

      expect((await codeStep(await passwordStep(), backupCodes[0]!)).body).toEqual(WRONG_CODE);
    });

    it('stores only hashes', async () => {
      const rows = await db.selectFrom('backup_codes').selectAll().where('account_id', '=', account.id).execute();

      expect(JSON.stringify(rows)).not.toContain(backupCodes[0]!.replaceAll('-', ''));
    });

    it('cannot make a spent code usable again, even as the table owner', async () => {
      await codeStep(await passwordStep(), backupCodes[0]!);
      const ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
      try {
        await expect(
          sql`update app.backup_codes set spent_at = null, spent_reason = null where account_id = ${account.id}`.execute(ownerDb),
        ).rejects.toThrow(/already spent/);
      } finally {
        await ownerDb.destroy();
      }
    });
  });

  describe('without a waiting sign-in', () => {
    it('asks to sign in again when there is no session', async () => {
      expect((await codeStep(undefined, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });

    it('does not let a fully signed-in session use it', async () => {
      const signedIn = cookieToken(await codeStep(await passwordStep(), currentCode()))!;
      nextWindow();

      expect((await codeStep(signedIn, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });

    it('asks to sign in again once the five minutes for the code have passed', async () => {
      const pending = await passwordStep();

      clock.advance(5 * MINUTE_MS);

      expect((await codeStep(pending, currentCode())).body).toEqual(SIGN_IN_AGAIN);
    });
  });

  describe('input checks', () => {
    it.each([
      ['no code', {}],
      ['a code that is too short', { code: '12345' }],
      ['an oversized code', { code: 'A'.repeat(33) }],
      ['an extra field', { code: '123456', trustDevice: true }],
    ])('rejects %s with 400', async (_case, body) => {
      const pending = await passwordStep();

      const response = await request(app.getHttpServer())
        .post('/auth/two-factor')
        .set('Cookie', `__Host-session=${pending}`)
        .send(body);

      expect(response.status).toBe(400);
    });

    it('cannot be submitted from another website', async () => {
      const pending = await passwordStep();

      const response = await codeStep(pending, currentCode()).set('Sec-Fetch-Site', 'cross-site');

      expect(response.status).toBe(403);
    });
  });
});
