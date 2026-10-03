import { Test } from '@nestjs/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '../../../test/accounts.js';
import { testEnv, testOwnerDatabaseUrl } from '../../../test/database.js';
import { FakeClock } from '../../../test/fake-clock.js';
import { CLOCK } from '../../common/time/clock.js';
import { ConfigModule } from '../../config/config.module.js';
import { createDatabase } from '../../database/database.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { AuthModule } from '../auth.module.js';
import { hotp, timeStep, TOTP_STEP_SECONDS } from './totp.js';
import { TotpCredentialsRepository } from './totp-credentials.repository.js';
import { AlreadyEnrolledError, TwoFactorService } from './two-factor.service.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

describe('TwoFactorService', () => {
  const clock = new FakeClock();
  let twoFactor: TwoFactorService;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let close: () => Promise<void>;
  let account: TestAccount;

  /** What the user's authenticator app would show right now. */
  const appCode = (secret: string, stepOffset = 0) => hotp(fromBase32(secret), timeStep(clock.now()) + stepOffset);

  async function enrol(): Promise<string> {
    const { secret } = await twoFactor.beginEnrolment(account);
    expect(await twoFactor.confirmEnrolment(account, appCode(secret))).toBe(true);
    clock.advance(TOTP_STEP_SECONDS * 1000);
    return secret;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testEnv()), AuthModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    await moduleRef.init();
    twoFactor = moduleRef.get(TwoFactorService);
    db = moduleRef.get(DATABASE);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 1);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await close();
  });

  beforeEach(async () => {
    clock.reset();
    account = await createTestAccount(db, 'client');
  });

  describe('enrolment', () => {
    it('gives the secret and a QR code link for the authenticator app', async () => {
      const enrolment = await twoFactor.beginEnrolment(account);

      expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(enrolment.uri).toBe(
        `otpauth://totp/Practice%20Portal%3A${encodeURIComponent(account.email)}?secret=${enrolment.secret}` +
          '&issuer=Practice+Portal&algorithm=SHA1&digits=6&period=30',
      );
    });

    it('stores the secret encrypted, never readable', async () => {
      const { secret } = await twoFactor.beginEnrolment(account);

      const row = await db.selectFrom('totp_credentials').selectAll().where('account_id', '=', account.id).executeTakeFirstOrThrow();
      expect(row.ciphertext.equals(fromBase32(secret))).toBe(false);
      expect(JSON.stringify(row)).not.toContain(secret);
    });

    it('is not active until a code from the app confirms it', async () => {
      await twoFactor.beginEnrolment(account);

      expect(await twoFactor.isEnrolled(account.id)).toBe(false);
    });

    it('confirms with the right code and records it', async () => {
      const { secret } = await twoFactor.beginEnrolment(account);

      expect(await twoFactor.confirmEnrolment(account, appCode(secret))).toBe(true);
      expect(await twoFactor.isEnrolled(account.id)).toBe(true);
      const events = await db.selectFrom('audit_events').select('action').where('actor_id', '=', account.id).execute();
      expect(events).toEqual([{ action: 'auth.two_factor_enrolled' }]);
    });

    it('does not confirm with a wrong code', async () => {
      const { secret } = await twoFactor.beginEnrolment(account);

      expect(await twoFactor.confirmEnrolment(account, appCode(secret, 5))).toBe(false);
      expect(await twoFactor.isEnrolled(account.id)).toBe(false);
    });

    it('replaces an unconfirmed secret if enrolment is restarted', async () => {
      const first = await twoFactor.beginEnrolment(account);
      const second = await twoFactor.beginEnrolment(account);

      expect(await twoFactor.confirmEnrolment(account, appCode(first.secret))).toBe(false);
      expect(await twoFactor.confirmEnrolment(account, appCode(second.secret))).toBe(true);
    });

    it('will not replace a confirmed secret', async () => {
      await enrol();

      await expect(twoFactor.beginEnrolment(account)).rejects.toThrow(AlreadyEnrolledError);
    });
  });

  describe('verify', () => {
    it('accepts the current code', async () => {
      const secret = await enrol();

      expect(await twoFactor.verify(account.id, appCode(secret))).toBe(true);
    });

    it('accepts each code only once', async () => {
      const secret = await enrol();
      const code = appCode(secret);

      expect(await twoFactor.verify(account.id, code)).toBe(true);
      expect(await twoFactor.verify(account.id, code)).toBe(false);
    });

    it('accepts only one of two simultaneous uses of the same code', async () => {
      const secret = await enrol();
      const code = appCode(secret);

      const results = await Promise.all([twoFactor.verify(account.id, code), twoFactor.verify(account.id, code)]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('refuses the code used to confirm enrolment', async () => {
      const { secret } = await twoFactor.beginEnrolment(account);
      const code = appCode(secret);
      await twoFactor.confirmEnrolment(account, code);

      expect(await twoFactor.verify(account.id, code)).toBe(false);
    });

    it('refuses a code once the next 30 seconds have passed twice', async () => {
      const secret = await enrol();
      const code = appCode(secret);

      clock.advance(2 * TOTP_STEP_SECONDS * 1000);

      expect(await twoFactor.verify(account.id, code)).toBe(false);
    });

    it('refuses any code for an account that has not finished enrolling', async () => {
      const { secret } = await twoFactor.beginEnrolment(account);

      expect(await twoFactor.verify(account.id, appCode(secret))).toBe(false);
    });

    it('refuses a code generated from another account secret', async () => {
      const secret = await enrol();
      const other = await createTestAccount(db, 'client');
      const { secret: otherSecret } = await twoFactor.beginEnrolment(other);

      expect(await twoFactor.verify(account.id, appCode(otherSecret))).toBe(false);
      expect(await twoFactor.verify(account.id, appCode(secret))).toBe(true);
    });

    it('fails closed when an encrypted secret is copied onto another account', async () => {
      await enrol();
      const victim = await createTestAccount(db, 'staff');
      await sql`
        insert into totp_credentials (account_id, key_version, nonce, ciphertext, auth_tag, created_at, confirmed_at)
        select ${victim.id}, key_version, nonce, ciphertext, auth_tag, created_at, confirmed_at
        from totp_credentials where account_id = ${account.id}
      `.execute(db);

      await expect(twoFactor.verify(victim.id, '000000')).rejects.toThrow(/integrity check/);
    });
  });

  // The service checks these too. Calling the repository directly proves the
  // database-level guards hold on their own, without relying on timing.
  describe('one-use guard in the repository', () => {
    let repository: TotpCredentialsRepository;

    beforeAll(() => {
      repository = new TotpCredentialsRepository(db);
    });

    it('records a time step once and refuses the same step again', async () => {
      await enrol();
      const step = timeStep(clock.now());

      expect(await repository.markStepUsed(account.id, step)).toBe(true);
      expect(await repository.markStepUsed(account.id, step)).toBe(false);
    });

    it('refuses an earlier step after a later one', async () => {
      await enrol();
      const step = timeStep(clock.now());
      await repository.markStepUsed(account.id, step);

      expect(await repository.markStepUsed(account.id, step - 1)).toBe(false);
    });

    it('refuses to record a step for an unconfirmed secret', async () => {
      await twoFactor.beginEnrolment(account);

      expect(await repository.markStepUsed(account.id, timeStep(clock.now()))).toBe(false);
    });
  });

  describe('database rules', () => {
    it('never lets a used time step move backwards, even for the owner', async () => {
      const secret = await enrol();
      await twoFactor.verify(account.id, appCode(secret));

      await expect(
        ownerDb.updateTable('totp_credentials').set({ last_used_step: 0 }).where('account_id', '=', account.id).execute(),
      ).rejects.toThrow(/can only move forward/);
    });

    it('does not let the app move a secret to another account', async () => {
      await enrol();

      await expect(
        sql`update totp_credentials set account_id = uuidv7() where account_id = ${account.id}`.execute(db),
      ).rejects.toThrow(/permission denied/);
    });

    it('does not let the app delete a secret', async () => {
      await enrol();

      await expect(sql`delete from totp_credentials where account_id = ${account.id}`.execute(db)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
