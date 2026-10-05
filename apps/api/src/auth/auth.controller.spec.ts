import { Module, type INestApplication } from '@nestjs/common';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { SessionsService } from './sessions/sessions.service.js';

@Module({})
class EmptyModule {}

describe('AuthController', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let staff: TestAccount;

  const withSession = (token: string) => `__Host-session=${token}`;

  beforeAll(async () => {
    app = await createTestApp(EmptyModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    staff = await createTestAccount(db, 'staff');
  });

  describe('GET /auth/session', () => {
    it('describes the signed-in account and nothing more', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      const response = await request(app.getHttpServer()).get('/auth/session').set('Cookie', withSession(token));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ account: { id: staff.id, kind: 'staff', displayName: 'Test staff' } });
    });

    it('refuses without a session', async () => {
      expect((await request(app.getHttpServer()).get('/auth/session')).status).toBe(401);
    });
  });

  describe('POST /auth/sign-out', () => {
    it('ends the session so the same cookie stops working', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      const signOut = await request(app.getHttpServer()).post('/auth/sign-out').set('Cookie', withSession(token));
      const afterwards = await request(app.getHttpServer()).get('/auth/session').set('Cookie', withSession(token));

      expect(signOut.status).toBe(204);
      expect(afterwards.status).toBe(401);
    });

    it('tells the browser to delete the cookie', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      const response = await request(app.getHttpServer()).post('/auth/sign-out').set('Cookie', withSession(token));

      expect(response.headers['set-cookie']).toEqual([
        '__Host-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      ]);
    });

    it('tells the browser to drop what it cached during the session (review W2)', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      const response = await request(app.getHttpServer()).post('/auth/sign-out').set('Cookie', withSession(token));

      expect(response.headers['clear-site-data']).toBe('"cache"');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('records the sign-out with the request details', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      await request(app.getHttpServer())
        .post('/auth/sign-out')
        .set('Cookie', withSession(token))
        .set('User-Agent', 'Firm Laptop Browser');

      const event = await db
        .selectFrom('audit_events')
        .select(['action', 'user_agent', 'resource_type'])
        .where('actor_id', '=', staff.id)
        .executeTakeFirstOrThrow();
      expect(event).toEqual({ action: 'auth.signed_out', user_agent: 'Firm Laptop Browser', resource_type: 'session' });
    });

    it('succeeds quietly without a session', async () => {
      expect((await request(app.getHttpServer()).post('/auth/sign-out')).status).toBe(204);
    });

    it('cannot be triggered by another website', async () => {
      const token = await sessions.start(staff, 'authenticated', {});

      const response = await request(app.getHttpServer())
        .post('/auth/sign-out')
        .set('Cookie', withSession(token))
        .set('Sec-Fetch-Site', 'cross-site');

      expect(response.status).toBe(403);
      expect((await sessions.resolve(token))?.account.id).toBe(staff.id);
    });
  });
});
