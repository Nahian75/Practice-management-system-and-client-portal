import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { AccountStatus, Database, StaffRole } from '../database/schema.js';
import { MattersModule } from './matters.module.js';

interface Colleague {
  id: string;
  displayName: string;
  isPartner: boolean;
}

describe('GET /colleagues', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;

  async function staffWith(roles: StaffRole[], status: AccountStatus = 'active'): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff', { status });
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }
  async function colleaguesAs(account: TestAccount) {
    const token = await sessions.start(account, 'authenticated', {});
    return request(app.getHttpServer()).get('/colleagues').set('Cookie', `__Host-session=${token}`);
  }
  const listed = async (viewer: TestAccount, account: TestAccount) =>
    ((await colleaguesAs(viewer)).body.colleagues as Colleague[]).find((colleague) => colleague.id === account.id);

  beforeAll(async () => {
    app = await createTestApp(MattersModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists active partners and fee earners by name only, marking the partners', async () => {
    const feeEarner = await staffWith(['fee_earner']);
    const partner = await staffWith(['partner', 'administrator']);

    const response = await colleaguesAs(feeEarner);

    expect(response.status).toBe(200);
    const colleagues = response.body.colleagues as Colleague[];
    expect(colleagues.find((colleague) => colleague.id === partner.id)).toEqual({ id: partner.id, displayName: 'Test staff', isPartner: true });
    expect(colleagues.find((colleague) => colleague.id === feeEarner.id)).toEqual({ id: feeEarner.id, displayName: 'Test staff', isPartner: false });
    for (const colleague of colleagues) {
      expect(Object.keys(colleague).sort()).toEqual(['displayName', 'id', 'isPartner']);
    }
  });

  it('leaves out staff who cannot work on matters, and accounts that are not active', async () => {
    const viewer = await staffWith(['fee_earner']);
    const others = [
      await staffWith(['administrator']),
      await staffWith(['accounts']),
      await staffWith(['compliance']),
      await staffWith([]),
      await staffWith(['partner'], 'invited'),
      await staffWith(['fee_earner'], 'disabled'),
    ];
    const clientAccount = await createTestAccount(db, 'client');

    const ids = ((await colleaguesAs(viewer)).body.colleagues as Colleague[]).map((colleague) => colleague.id);

    for (const account of [...others, clientAccount]) {
      expect(ids).not.toContain(account.id);
    }
  });

  it('follows role changes at once', async () => {
    const viewer = await staffWith(['fee_earner']);
    const partner = await staffWith(['partner', 'fee_earner']);

    await revokeTestRole(db, partner.id, 'partner');
    expect(await listed(viewer, partner)).toMatchObject({ isPartner: false });

    await revokeTestRole(db, partner.id, 'fee_earner');
    expect(await listed(viewer, partner)).toBeUndefined();

    await grantTestRole(db, partner.id, 'partner');
    await setAccountStatus(db, partner.id, 'disabled');
    expect(await listed(viewer, partner)).toBeUndefined();
  });

  it('is refused to anyone who cannot open matters', async () => {
    for (const roles of [['administrator'], ['accounts'], ['compliance'], []] as StaffRole[][]) {
      expect((await colleaguesAs(await staffWith(roles))).status).toBe(403);
    }
    expect((await request(app.getHttpServer()).get('/colleagues')).status).toBe(401);
  });
});
