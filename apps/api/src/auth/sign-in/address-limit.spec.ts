import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '../../../test/accounts.js';
import { createTestApp, randomTestAddress } from '../../../test/create-test-app.js';
import { FakeClock, MINUTE_MS } from '../../../test/fake-clock.js';
import { authenticatorCode, enrolTwoFactor } from '../../../test/two-factor.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { MAX_FAILURES_PER_ADDRESS } from './sign-in-limits.js';

const PASSWORD = 'tidy-otter-quartz-lantern';
const TOO_MANY = { statusCode: 429, message: 'Too many failed attempts from your network. Try again later' };

@Module({})
class EmptyModule {}

describe('Per-address sign-in limit', () => {
  const clock = new FakeClock();
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let passwordHash: string;
  let account: TestAccount;
  let secret: string;
  let address: string;

  const signInFrom = (from: string, email: string, password: string) =>
    request(app.getHttpServer()).post('/auth/sign-in').set('X-Forwarded-For', from).send({ email, password });

  /** Wrong guesses against many different accounts: password spraying. */
  async function sprayFrom(from: string, times: number) {
    for (let i = 0; i < times; i += 1) {
      await signInFrom(from, `someone-${randomUUID()}@example.com`, 'Summer2026!Summer');
    }
  }

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
    address = randomTestAddress();
    account = await createTestAccount(db, 'staff', { passwordHash });
    secret = await enrolTwoFactor(app.get(TwoFactorService), account, clock);
  });

  it(`blocks an address after ${MAX_FAILURES_PER_ADDRESS} failures across many accounts`, async () => {
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS);

    const response = await signInFrom(address, account.email, PASSWORD);

    expect(response.status).toBe(429);
    expect(response.body).toEqual(TOO_MANY);
    expect(response.headers['retry-after']).toBe('900');
  });

  it('does not block one failure early', async () => {
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS - 1);

    expect((await signInFrom(address, account.email, PASSWORD)).status).toBe(200);
  });

  it('leaves other addresses alone', async () => {
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS);

    expect((await signInFrom(randomTestAddress(), account.email, PASSWORD)).status).toBe(200);
  });

  it('never counts successful sign-ins, so a busy office is not blocked', async () => {
    const office = randomTestAddress();
    const statuses: number[] = [];
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS + 10; i += 1) {
      statuses.push((await signInFrom(office, account.email, PASSWORD)).status);
    }

    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('lifts the limit after 15 minutes', async () => {
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS);

    clock.advance(15 * MINUTE_MS);

    expect((await signInFrom(address, account.email, PASSWORD)).status).toBe(200);
  });

  it('applies to the 2FA step as well', async () => {
    const signIn = await signInFrom(address, account.email, PASSWORD);
    const pending = /__Host-session=([^;]+)/.exec(String(signIn.headers['set-cookie']))?.[1];
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS);

    const response = await request(app.getHttpServer())
      .post('/auth/two-factor')
      .set('X-Forwarded-For', address)
      .set('Cookie', `__Host-session=${pending}`)
      .send({ code: authenticatorCode(secret, clock) });

    expect(response.status).toBe(429);
  });

  it('records the refused attempt with its address', async () => {
    await sprayFrom(address, MAX_FAILURES_PER_ADDRESS);
    await signInFrom(address, account.email, PASSWORD);

    const event = await db
      .selectFrom('audit_events')
      .select(['action', 'actor_type', 'metadata'])
      .where('ip_address', '=', address)
      .where('action', '=', 'auth.sign_in_rate_limited')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      action: 'auth.sign_in_rate_limited',
      actor_type: 'anonymous',
      metadata: { reason: 'too_many_failures_from_address' },
    });
  });
});

describe('Without trusted proxies', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp(EmptyModule, { env: { TRUSTED_PROXIES: [] } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('ignores X-Forwarded-For, so a forged header cannot dodge the limit', async () => {
    for (let i = 0; i <= MAX_FAILURES_PER_ADDRESS; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/sign-in')
        .set('X-Forwarded-For', randomTestAddress())
        .send({ email: `someone-${randomUUID()}@example.com`, password: 'Summer2026!Summer' });
    }

    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('X-Forwarded-For', randomTestAddress())
      .send({ email: `someone-${randomUUID()}@example.com`, password: 'Summer2026!Summer' });

    expect(response.status).toBe(429);
  });

  it('records the real connection address, not the forged one', async () => {
    const forged = randomTestAddress();

    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('X-Forwarded-For', forged)
      .send({ email: `someone-${randomUUID()}@example.com`, password: 'x' });

    const db = app.get<Kysely<Database>>(DATABASE);
    const forgedRows = await db.selectFrom('audit_events').select('id').where('ip_address', '=', forged).execute();
    expect(forgedRows).toEqual([]);
  });
});
