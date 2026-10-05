import { createHash, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { FakeClock, HOUR_MS } from '../../../test/fake-clock.js';
import { waitForEmails } from '../../../test/mailpit.js';
import { authenticatorCode } from '../../../test/two-factor.js';
import { hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import { DATABASE } from '../../database/database.module.js';
import type { AccountKind, Database } from '../../database/schema.js';
import { TOTP_STEP_SECONDS } from '../two-factor/totp.js';
import { AccountNotInvitableError, InvitationsService } from './invitations.service.js';

const PASSWORD = 'tidy-otter-quartz-lantern';
const INVALID = { statusCode: 404, message: 'This invitation link is invalid or has expired' };
const SYSTEM = { actor: { type: 'system' } as const, accountId: null };

@Module({})
class EmptyModule {}

describe('Invitations', () => {
  const clock = new FakeClock();
  let app: INestApplication;
  let db: Kysely<Database>;
  let invitations: InvitationsService;
  let email: string;

  const post = (path: string, body: object) => request(app.getHttpServer()).post(`/auth/invitations/${path}`).send(body);

  async function invite(kind: AccountKind = 'client', address = email): Promise<string> {
    const before = (await waitForEmails(address, 0)).length;
    await invitations.invite({ kind, email: address, displayName: 'Jane Doe' }, SYSTEM);
    const emails = await waitForEmails(address, before + 1);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(emails.at(-1)?.text ?? '')?.[1];
    if (!token) {
      throw new Error('No invitation link in the email');
    }
    return token;
  }

  /** Runs the whole acceptance and returns the 2FA secret and backup codes. */
  async function accept(token: string) {
    const passwordStep = await post('password', { token, password: PASSWORD });
    const secret: string = passwordStep.body.twoFactor.secret;
    const complete = await post('complete', { token, code: authenticatorCode(secret, clock) });
    return { secret, complete };
  }

  const accountStatus = async (address: string) =>
    (await db.selectFrom('accounts').select('status').where('email', '=', address).executeTakeFirst())?.status;

  beforeAll(async () => {
    app = await createTestApp(EmptyModule, { clock });
    db = app.get(DATABASE);
    invitations = app.get(InvitationsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.reset();
    email = `invitee-${randomUUID()}@example.com`;
  });

  describe('sending', () => {
    it('emails a link that carries the token after #, so it never reaches a server log', async () => {
      await invite();

      const [message] = await waitForEmails(email);
      expect(message?.subject).toBe('Set up your Practice Portal account');
      expect(message?.text).toMatch(/http:\/\/localhost:3000\/accept-invitation#token=[A-Za-z0-9_-]{43}/);
    });

    it('creates the account as invited, unable to sign in', async () => {
      await invite();

      expect(await accountStatus(email)).toBe('invited');
    });

    it('stores only a hash of the token', async () => {
      const token = await invite();

      const rows = await db.selectFrom('invitations').selectAll().execute();
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows.some((row) => row.token_hash.equals(hashOpaqueToken(token)))).toBe(true);
    });

    it('records who sent the invitation', async () => {
      await invite('staff');

      // This account's event: other test files send invitations at the same time.
      const { id } = await db.selectFrom('accounts').select('id').where('email', '=', email).executeTakeFirstOrThrow();
      const event = await db
        .selectFrom('audit_events')
        .select(['actor_type', 'action', 'metadata'])
        .where('action', '=', 'account.invited')
        .where('resource_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ actor_type: 'system', action: 'account.invited', metadata: { kind: 'staff' } });
    });

    it('refuses to invite an email that already has an active account', async () => {
      const existing = await createTestAccount(db, 'staff');

      await expect(invitations.invite({ kind: 'staff', email: existing.email, displayName: 'X' }, SYSTEM)).rejects.toThrow(
        AccountNotInvitableError,
      );
    });

    it('refuses to re-invite an invited client as staff', async () => {
      await invite('client');

      await expect(invitations.invite({ kind: 'staff', email, displayName: 'X' }, SYSTEM)).rejects.toThrow(
        AccountNotInvitableError,
      );
    });

    it('cancels the earlier link when a new invitation is sent', async () => {
      const first = await invite();
      const second = await invite();

      expect((await post('inspect', { token: first })).body).toEqual(INVALID);
      expect((await post('inspect', { token: second })).status).toBe(200);
    });
  });

  describe('inspect', () => {
    it('shows who the invitation is for', async () => {
      const token = await invite();

      expect((await post('inspect', { token })).body).toEqual({ email, displayName: 'Jane Doe', kind: 'client' });
    });

    it('treats an unknown token as invalid', async () => {
      expect((await post('inspect', { token: 'A'.repeat(43) })).body).toEqual(INVALID);
    });

    it('expires after seven days', async () => {
      const token = await invite();

      clock.advance(7 * 24 * HOUR_MS);

      expect((await post('inspect', { token })).body).toEqual(INVALID);
    });
  });

  describe('accepting', () => {
    it('sets a password, enrols 2FA, gives ten backup codes and activates the account', async () => {
      const token = await invite();

      const { secret, complete } = await accept(token);

      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(complete.status).toBe(200);
      expect(complete.body.backupCodes).toHaveLength(10);
      expect(await accountStatus(email)).toBe('active');
    });

    it('lets the new account sign in with its password and authenticator', async () => {
      const token = await invite('staff');
      const { secret } = await accept(token);
      clock.advance(TOTP_STEP_SECONDS * 1000);

      const signIn = await request(app.getHttpServer()).post('/auth/sign-in').send({ email, password: PASSWORD });
      const pending = /__Host-session=([^;]+)/.exec(String(signIn.headers['set-cookie']))?.[1];
      const twoFactor = await request(app.getHttpServer())
        .post('/auth/two-factor')
        .set('Cookie', `__Host-session=${pending}`)
        .send({ code: authenticatorCode(secret, clock) });

      expect(twoFactor.status).toBe(200);
      expect(twoFactor.body.account.kind).toBe('staff');
    });

    it('works once only', async () => {
      const token = await invite();
      await accept(token);

      expect((await post('inspect', { token })).body).toEqual(INVALID);
      expect((await post('password', { token, password: 'another-long-password-1' })).body).toEqual(INVALID);
    });

    // The account no longer being "invited" also blocks reuse. This checks the
    // invitation itself is closed, so neither guard depends on the other.
    it('closes the invitation when it is accepted', async () => {
      const token = await invite();
      await accept(token);

      const invitation = await db
        .selectFrom('invitations')
        .select(['closed_at', 'close_reason'])
        .where('token_hash', '=', hashOpaqueToken(token))
        .executeTakeFirstOrThrow();
      expect(invitation.close_reason).toBe('accepted');
      expect(invitation.closed_at).not.toBeNull();
    });

    it('leaves the account unable to sign in until 2FA is confirmed', async () => {
      const token = await invite();
      await post('password', { token, password: PASSWORD });

      const signIn = await request(app.getHttpServer()).post('/auth/sign-in').send({ email, password: PASSWORD });

      expect(await accountStatus(email)).toBe('invited');
      expect(signIn.status).toBe(401);
    });

    it.each([
      ['too short', () => 'short-pass', 'Use at least 12 characters'],
      ['containing the email name', () => `my-${email.split('@')[0]}-password`, 'Do not include your email address'],
    ])('rejects a password %s with a clear reason', async (_case, makePassword, message) => {
      const token = await invite();

      const response = await post('password', { token, password: makePassword() });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain(message);
    });

    it('rejects a password found in a data breach', async () => {
      // Long enough to pass the local rules, so only the breach check can reject it.
      const breachedPassword = 'correct horse battery staple';
      const suffix = createHash('sha1').update(breachedPassword).digest('hex').toUpperCase().slice(5);
      const breachedApp = await createTestApp(EmptyModule, {
        clock,
        fetch: async () => new Response(`${suffix}:3812\r\n`),
      });
      try {
        await breachedApp.get(InvitationsService).invite({ kind: 'client', email, displayName: 'Jane' }, SYSTEM);
        const token = /#token=([A-Za-z0-9_-]{43})/.exec((await waitForEmails(email)).at(-1)!.text)![1];

        const response = await request(breachedApp.getHttpServer())
          .post('/auth/invitations/password')
          .send({ token, password: breachedPassword });

        expect(response.body.message).toContain('This password has appeared in a data breach. Choose a different one');
      } finally {
        await breachedApp.close();
      }
    });

    it('refuses to finish before a password is chosen', async () => {
      const token = await invite();

      const response = await post('complete', { token, code: '123456' });

      expect(response.body).toEqual({ statusCode: 400, message: 'Choose a password first' });
    });

    it('refuses a wrong 2FA code and lets the person try again', async () => {
      const token = await invite();
      const { body } = await post('password', { token, password: PASSWORD });
      const secret = body.twoFactor.secret as string;

      const wrong = await post('complete', { token, code: authenticatorCode(secret, clock, 5) });
      const right = await post('complete', { token, code: authenticatorCode(secret, clock) });

      expect(wrong.body).toEqual({ statusCode: 400, message: 'The code is incorrect' });
      expect(right.status).toBe(200);
    });

    it('records the acceptance', async () => {
      const token = await invite();
      await accept(token);

      const account = await db.selectFrom('accounts').select('id').where('email', '=', email).executeTakeFirstOrThrow();
      const actions = await db.selectFrom('audit_events').select('action').where('actor_id', '=', account.id).execute();
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining(['auth.two_factor_enrolled', 'auth.backup_codes_issued', 'auth.invitation_accepted']),
      );
    });
  });

  describe('input checks', () => {
    it.each([
      ['a token in the wrong format', 'inspect', { token: 'abc' }],
      ['an extra field', 'inspect', { token: 'A'.repeat(43), admin: true }],
      ['no password', 'password', { token: 'A'.repeat(43) }],
      ['an oversized password', 'password', { token: 'A'.repeat(43), password: 'x'.repeat(1025) }],
    ])('rejects %s with 400', async (_case, path, body) => {
      expect((await post(path, body)).status).toBe(400);
    });

    it('cannot be submitted from another website', async () => {
      const token = await invite();

      const response = await post('password', { token, password: PASSWORD }).set('Sec-Fetch-Site', 'cross-site');

      expect(response.status).toBe(403);
    });
  });
});
