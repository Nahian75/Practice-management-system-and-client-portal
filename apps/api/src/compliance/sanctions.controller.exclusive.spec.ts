import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import { createAmlStaff } from '../../test/aml.js';
import { createTestApp } from '../../test/create-test-app.js';
import { sanctionsCsv } from '../../test/sanctions.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';
import { SanctionsService } from './sanctions.service.js';

@Module({ imports: [ComplianceModule] })
class SanctionsTestModule {}

const LIST_URL = 'https://sanctions.example.test/UK-Sanctions-List.csv';

describe('sanctions list import', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let sanctions: SanctionsService;
  let compliance: TestAccount;
  let partner: TestAccount;
  let complianceToken: string;
  let partnerToken: string;

  const cookie = (token: string) => `__Host-session=${token}`;
  const upload = (token: string, csv: string) => request(app.getHttpServer()).post('/compliance/sanctions/lists')
    .set('Cookie', cookie(token)).attach('file', Buffer.from(csv), 'UK-Sanctions-List.csv');
  /** A distinct, valid list, newest-dated so earlier imports in this database never make it "older". */
  const freshList = (reportDate = '31-Dec-2099') => sanctionsCsv(reportDate, [
    { uniqueId: `TST${randomUUID().slice(0, 6)}`, names: ['Test', randomUUID().slice(0, 8).replace(/\d/g, 'X')] },
  ]);

  beforeAll(async () => {
    app = await createTestApp(SanctionsTestModule, { env: { SANCTIONS_LIST_URL: LIST_URL } });
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
    sanctions = app.get(SanctionsService);
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    compliance = await createAmlStaff(db, 'compliance');
    partner = await createAmlStaff(db, 'partner');
    [complianceToken, partnerToken] = await Promise.all([
      sessions.start(compliance, 'authenticated', {}), sessions.start(partner, 'authenticated', {}),
    ]);
  });

  it('lets Compliance upload a list that becomes the active, fresh version', async () => {
    const csv = freshList();
    expect((await upload(partnerToken, csv)).status).toBe(403);

    const imported = await upload(complianceToken, csv);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(imported.body).toMatchObject({ outcome: 'imported', list: { source: 'upload', reportDate: '2099-12-31', designationCount: 1 } });
    const status = await request(app.getHttpServer()).get('/compliance/sanctions/status').set('Cookie', cookie(complianceToken));
    expect(status.body).toMatchObject({ listId: imported.body.list.id, version: imported.body.list.version, fresh: true });

    const again = await upload(complianceToken, csv);
    expect(again.body).toMatchObject({ outcome: 'unchanged', list: { id: imported.body.list.id } });
    const audit = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', imported.body.list.id).execute();
    expect(audit).toEqual([{ action: 'aml.sanctions_list_activated', metadata: { version: imported.body.list.version, designations: 1 } }]);
  });

  it('refuses an older report or a file that is not the official list, and records the refusal', async () => {
    expect((await upload(complianceToken, freshList())).status).toBe(201);
    expect((await upload(complianceToken, freshList('01-Jan-2000'))).status).toBe(409);
    expect((await upload(complianceToken, 'name,date\r\nSomeone,2020-01-01\r\n')).status).toBe(422);

    const failures = await db.selectFrom('aml_sanctions_checks').select('failure').where('checked_by', '=', compliance.id)
      .where('outcome', '=', 'failed').orderBy('checked_at').execute();
    expect(failures.map((row) => row.failure)).toEqual(['older_report', 'format']);
  });

  it('downloads the list on refresh and keeps the last good version when a download fails', async () => {
    const csv = freshList();
    let requested: string | undefined;
    const ok = await sanctions.refresh(async (url) => {
      requested = String(url);
      return new Response(csv, { status: 200 });
    });
    expect(requested).toBe(LIST_URL);
    expect(ok).toMatchObject({ outcome: 'imported', list: { source: 'download' } });

    const offline = await sanctions.refresh(async () => { throw new TypeError('fetch failed'); });
    expect(offline).toEqual({ outcome: 'refused', reason: 'download' });
    const missing = await sanctions.refresh(async () => new Response('Not found', { status: 404 }));
    expect(missing).toEqual({ outcome: 'refused', reason: 'download' });
    const huge = await sanctions.refresh(async () => new Response('x', { status: 200, headers: { 'content-length': String(200 * 1024 * 1024) } }));
    expect(huge).toEqual({ outcome: 'refused', reason: 'too_large' });

    const status = await sanctions.status();
    expect(status.listId).toBe(ok.outcome === 'imported' ? ok.list.id : null);
    expect(status.lastFailureAt).not.toBeNull();
  });

  it('is fresh only while a successful check falls inside the window', async () => {
    await upload(complianceToken, freshList());
    const within = async (window: string) => (await sql<{ ok: boolean }>`
      select app.aml_sanctions_checked_within(${window}::interval) as ok`.execute(db)).rows[0]!.ok;
    expect(await within('48 hours')).toBe(true);
    expect(await within('0 seconds')).toBe(false);
    expect((await sanctions.status()).fresh).toBe(true);
  });

  it('keeps list versions immutable and refuses direct writes', async () => {
    const imported = await upload(complianceToken, freshList());
    const owner = (await import('../database/database.js')).createDatabase<Database>((await import('../../test/database.js')).testOwnerDatabaseUrl(), 1);
    try {
      await expect(owner.updateTable('aml_sanctions_names').set({ name: 'Rewritten' } as never)
        .where('list_id', '=', imported.body.list.id).execute()).rejects.toMatchObject({ code: '42501' });
      await expect(sql`insert into app.aml_sanctions_checks(outcome, failure) values ('failed', 'download')`.execute(db))
        .rejects.toMatchObject({ code: '42501' });
      await expect(sql`truncate app.aml_sanctions_lists cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
      await expect(sql`select app.import_aml_sanctions_list('2099-12-31'::date, ${Buffer.alloc(32, 9)}, 10,
        '[]'::jsonb, '[]'::jsonb, ${partner.id}::uuid)`.execute(db)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await owner.destroy();
    }
  });
});
