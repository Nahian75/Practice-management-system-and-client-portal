import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../../test/accounts.js';
import { createTestApp } from '../../../test/create-test-app.js';
import { ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { RequirePermission } from './require-permission.decorator.js';

const okSchema = z.object({ ok: z.literal(true) });

@Controller('fixture')
class PermissionFixtureController {
  @Get('invite')
  @RequirePermission('staff.invite')
  @ResponseSchema(okSchema)
  invite() {
    return { ok: true };
  }

  @Get('audit')
  @RequirePermission('audit.view')
  @ResponseSchema(okSchema)
  audit() {
    return { ok: true };
  }
}

@Module({ controllers: [PermissionFixtureController] })
class PermissionFixtureModule {}

describe('PermissionGuard', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set('Cookie', `__Host-session=${token}`) : call;
  };
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});

  async function staffWith(...roles: Parameters<typeof grantTestRole>[2][]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  beforeAll(async () => {
    app = await createTestApp(PermissionFixtureModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  let admin: TestAccount;

  beforeEach(async () => {
    admin = await staffWith('administrator');
  });

  it('lets a role with the permission through', async () => {
    expect((await get('/fixture/invite', await signedIn(admin))).status).toBe(200);
  });

  it.each(['partner', 'fee_earner', 'accounts', 'compliance'] as const)('refuses a %s', async (role) => {
    const account = await staffWith(role);

    expect((await get('/fixture/invite', await signedIn(account))).status).toBe(403);
  });

  it('refuses staff with no roles', async () => {
    expect((await get('/fixture/invite', await signedIn(await staffWith()))).status).toBe(403);
  });

  it('keeps administrators out of the audit log', async () => {
    expect((await get('/fixture/audit', await signedIn(admin))).status).toBe(403);
  });

  it('combines roles: a partner who is also compliance can read the audit log', async () => {
    const account = await staffWith('partner', 'compliance');

    expect((await get('/fixture/audit', await signedIn(account))).status).toBe(200);
  });

  it('applies a revoked role on the very next request, without signing out', async () => {
    const token = await signedIn(admin);
    expect((await get('/fixture/invite', token)).status).toBe(200);

    await revokeTestRole(db, admin.id, 'administrator');

    expect((await get('/fixture/invite', token)).status).toBe(403);
  });

  it('records a refusal with the permission that was missing', async () => {
    const partner = await staffWith('partner');

    await get('/fixture/invite', await signedIn(partner));

    const event = await db
      .selectFrom('audit_events')
      .select(['action', 'outcome', 'metadata'])
      .where('actor_id', '=', partner.id)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      action: 'auth.permission_denied',
      outcome: 'denied',
      metadata: { permission: 'staff.invite', method: 'GET', path: '/fixture/invite' },
    });
  });

  it('keeps clients out, before any permission is looked at', async () => {
    const client = await createTestAccount(db, 'client');

    expect((await get('/fixture/invite', await signedIn(client))).status).toBe(403);
  });

  it('asks for sign-in when there is no session', async () => {
    expect((await get('/fixture/invite')).status).toBe(401);
  });
});
