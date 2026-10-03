import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestAccount, setAccountStatus, type TestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { AnyAccount, ClientOnly, Public, StaffOnly } from './access.decorators.js';
import { SessionsService } from './sessions.service.js';

const okSchema = z.object({ ok: z.literal(true) });
let undeclaredCalls = 0;

@Controller('fixture')
class AccessFixtureController {
  @Get('public')
  @Public()
  @ResponseSchema(okSchema)
  open() {
    return { ok: true };
  }

  @Get('staff')
  @StaffOnly()
  @ResponseSchema(okSchema)
  staffArea() {
    return { ok: true };
  }

  @Get('client')
  @ClientOnly()
  @ResponseSchema(okSchema)
  clientArea() {
    return { ok: true };
  }

  @Get('any')
  @AnyAccount()
  @ResponseSchema(okSchema)
  anyArea() {
    return { ok: true };
  }

  @Get('undeclared')
  @ResponseSchema(okSchema)
  undeclared() {
    undeclaredCalls += 1;
    return { ok: true };
  }
}

@Module({ controllers: [AccessFixtureController] })
class AccessFixtureModule {}

describe('SessionGuard', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let staff: TestAccount;
  let client: TestAccount;

  const cookie = (token: string) => `__Host-session=${token}`;
  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set('Cookie', cookie(token)) : call;
  };

  beforeAll(async () => {
    app = await createTestApp(AccessFixtureModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    staff = await createTestAccount(db, 'staff');
    client = await createTestAccount(db, 'client');
  });

  it('lets anyone reach a public route', async () => {
    expect((await get('/fixture/public')).status).toBe(200);
  });

  it.each(['/fixture/staff', '/fixture/client', '/fixture/any'])('refuses %s without a session', async (path) => {
    expect((await get(path)).status).toBe(401);
  });

  it('refuses a made-up token', async () => {
    expect((await get('/fixture/any', 'A'.repeat(43))).status).toBe(401);
  });

  it('refuses a session that is still waiting for its 2FA code', async () => {
    const token = await sessions.start(staff, 'two_factor_pending', {});

    expect((await get('/fixture/staff', token)).status).toBe(401);
    expect((await get('/fixture/any', token)).status).toBe(401);
  });

  it('lets staff into staff routes and shared routes', async () => {
    const token = await sessions.start(staff, 'authenticated', {});

    expect((await get('/fixture/staff', token)).status).toBe(200);
    expect((await get('/fixture/any', token)).status).toBe(200);
  });

  it('lets clients into client routes and shared routes', async () => {
    const token = await sessions.start(client, 'authenticated', {});

    expect((await get('/fixture/client', token)).status).toBe(200);
    expect((await get('/fixture/any', token)).status).toBe(200);
  });

  it('keeps a client out of staff routes and records the attempt', async () => {
    const token = await sessions.start(client, 'authenticated', {});

    expect((await get('/fixture/staff', token)).status).toBe(403);

    const events = await db
      .selectFrom('audit_events')
      .select(['action', 'outcome', 'metadata'])
      .where('actor_id', '=', client.id)
      .execute();
    expect(events).toEqual([
      {
        action: 'auth.access_denied',
        outcome: 'denied',
        metadata: { method: 'GET', path: '/fixture/staff', required: 'staff' },
      },
    ]);
  });

  it('keeps staff out of client routes', async () => {
    const token = await sessions.start(staff, 'authenticated', {});

    expect((await get('/fixture/client', token)).status).toBe(403);
  });

  it('refuses a session after the account is disabled', async () => {
    const token = await sessions.start(staff, 'authenticated', {});
    await setAccountStatus(db, staff.id, 'disabled');

    expect((await get('/fixture/staff', token)).status).toBe(401);
  });

  it('refuses a route that does not declare who may call it, without running it', async () => {
    const token = await sessions.start(staff, 'authenticated', {});

    const response = await get('/fixture/undeclared', token);

    expect(response.status).toBe(500);
    expect(undeclaredCalls).toBe(0);
  });
});
