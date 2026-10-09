import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { FinanceModule } from './finance.module.js';

@Module({ imports: [FinanceModule] })
class BillingTestModule {}

describe('Billing API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let partner: TestAccount;
  let accounts: TestAccount;
  let compliance: TestAccount;
  let outsider: TestAccount;
  let matterId: string;
  let today: string;
  let accountsToken: string;
  let partnerToken: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (token: string) => `__Host-session=${token}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  const as = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
      put: (path: string, body: object) => server.put(path).set('Cookie', cookie(token)).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function openMatter(): Promise<string> {
    const client = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('clients').values({ kind: 'individual', created_by: partner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: row.id, given_names: 'Jamie', family_name: uniqueName(),
        address_line1: '22 Client Road', town: 'Bristol', postcode: 'BS1 1AA', country: 'GB',
      }).execute();
      return row;
    });
    const check = await db.insertInto('conflict_checks').values({ client_id: client.id, requested_by: partner.id, names: [uniqueName()] }).returning('id').executeTakeFirstOrThrow();
    const matter = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('matters').values({ client_id: client.id, title: 'Billing API matter', matter_type: 'other', opened_by: partner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values({ matter_id: row.id, account_id: partner.id, role: 'supervising_partner', added_by: partner.id }).execute();
      return row;
    });
    return matter.id;
  }

  const body = (overrides: object = {}) => ({
    taxPoint: today,
    dueOn: today,
    supplier: {
      name: 'Stass Legal LLP', addressLine1: '1 Justice Street', addressLine2: null,
      town: 'London', postcode: 'SW1A 1AA', country: 'GB', vatRegistrationNumber: 'GB123456789',
    },
    lines: [{ kind: 'fee', description: 'Professional fees', net: '100.03', vatTreatment: 'standard', timeEntryId: null }],
    ...overrides,
  });

  const createDraft = (token = accountsToken, overrides: object = {}) => as(token).post(`/matters/${matterId}/bill-drafts`, body(overrides));

  beforeAll(async () => {
    app = await createTestApp(BillingTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    partner = await staffWith('partner');
    accounts = await staffWith('accounts');
    compliance = await staffWith('compliance');
    outsider = await staffWith('fee_earner');
    accountsToken = await signedIn(accounts);
    partnerToken = await signedIn(partner);
    matterId = await openMatter();
  });

  it('lets Accounts create, read and replace a draft with exact money and audits ids only', async () => {
    const created = await createDraft();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.any(String), matterId, status: 'draft', taxPoint: today, dueOn: today,
      net: '100.03', vat: '20.01', gross: '120.04',
      lines: [{ position: 1, net: '100.03', vat: '20.01', gross: '120.04' }],
    });
    expect((await as(accountsToken).get(`/bill-drafts/${created.body.id}`)).body).toEqual(created.body);
    const queue = await as(accountsToken).get('/finance/bill-drafts');
    expect(queue.status).toBe(200);
    expect(queue.body.drafts).toContainEqual(expect.objectContaining({ id: created.body.id, matterId, gross: '120.04' }));
    expect((await as(await signedIn(compliance)).get('/finance/bill-drafts')).status).toBe(403);

    const changed = await as(accountsToken).put(`/bill-drafts/${created.body.id}`, body({
      lines: [{ kind: 'disbursement', description: 'Search fee', net: '25.00', vatTreatment: 'outside_scope', timeEntryId: null }],
    }));
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ net: '25.00', vat: '0.00', gross: '25.00' });
    const events = await db.selectFrom('audit_events').select(['action', 'metadata']).where('resource_id', '=', created.body.id).orderBy('id').execute();
    expect(events.map((event) => event.action)).toEqual(['bill.draft_created', 'bill.draft_updated']);
    expect(JSON.stringify(events)).not.toContain('Professional fees');
  });

  it('refuses non-Accounts staff, unknown fields and invalid bill money', async () => {
    expect((await createDraft(partnerToken)).status).toBe(403);
    expect((await createDraft(accountsToken, { unexpected: true })).status).toBe(400);
    expect((await createDraft(accountsToken, { lines: [{ kind: 'fee', description: 'Fee', net: '0.00', vatTreatment: 'standard', timeEntryId: null }] })).status).toBe(400);
    expect((await createDraft(accountsToken, { lines: [{ kind: 'fee', description: 'Fee', net: '1e2', vatTreatment: 'standard', timeEntryId: null }] })).status).toBe(400);
  });

  it('issues once, locks the draft and limits issued bill reads to the matter team or finance-wide roles', async () => {
    const draft = await createDraft();
    const issued = await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`, {});
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ reference: expect.stringMatching(/^INV-/), matterId, issuedOn: today, net: '100.03', vat: '20.01', gross: '120.04' });
    expect((await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`, {})).status).toBe(409);
    expect((await as(accountsToken).put(`/bill-drafts/${draft.body.id}`, body())).status).toBe(409);
    expect((await as(partnerToken).get(`/bills/${issued.body.id}`)).status).toBe(200);
    expect((await as(await signedIn(compliance)).get(`/bills/${issued.body.id}`)).status).toBe(200);
    expect((await as(await signedIn(outsider)).get(`/bills/${issued.body.id}`)).status).toBe(404);
    const listed = await as(partnerToken).get(`/matters/${matterId}/bills`);
    expect(listed.body.bills).toEqual([expect.objectContaining({ id: issued.body.id })]);
    expect(JSON.stringify(listed.body)).not.toContain('Professional fees');
    expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'bill.issued').where('resource_id', '=', issued.body.id).executeTakeFirst()).toBeDefined();
  });

  it('downloads a fixed UTF-8 bill with safe headers and records the audit event', async () => {
    const draft = await createDraft();
    const issued = await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`, {});
    const downloaded = await as(partnerToken).get(`/bills/${issued.body.id}/content`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toMatch(/^text\/plain; charset=utf-8/);
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment; filename="INV-\d+\.txt"$/);
    expect(downloaded.headers['cache-control']).toBe('no-store');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(downloaded.text).toContain(`${issued.body.reference}\n`);
    expect(downloaded.text).toContain('Professional fees');
    expect((await as(await signedIn(outsider)).get(`/bills/${issued.body.id}/content`)).status).toBe(404);
    expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'bill.downloaded').where('resource_id', '=', issued.body.id).executeTakeFirst()).toBeDefined();
  });

  it('lets Accounts issue and download a credit note and record delivery without sending anything', async () => {
    const draft = await createDraft();
    const bill = await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`, {});
    const credit = await as(accountsToken).post(`/bills/${bill.body.id}/credit-notes`, {
      reason: 'The agreed fee was reduced', lines: [{ billLineId: bill.body.lines[0].id, net: '10.00' }],
    });
    expect(credit.status).toBe(201);
    expect(credit.body).toMatchObject({ reference: expect.stringMatching(/^CRN-/), billId: bill.body.id, net: '10.00', vat: '2.00', gross: '12.00' });
    expect((await as(partnerToken).get(`/credit-notes/${credit.body.id}`)).status).toBe(200);
    const content = await as(partnerToken).get(`/credit-notes/${credit.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.text).toContain(`Original bill: ${bill.body.reference}`);
    expect(content.text).toContain(`Issue date: ${today}`);
    expect(content.text).toContain('Supplier: Stass Legal LLP');
    expect((await as(accountsToken).post(`/bills/${bill.body.id}/deliveries`, { method: 'email', note: 'Sent from the firm mailbox' })).status).toBe(201);
    expect((await as(accountsToken).post(`/credit-notes/${credit.body.id}/deliveries`, { method: 'post', note: null })).status).toBe(201);
    expect((await as(partnerToken).post(`/bills/${bill.body.id}/deliveries`, { method: 'email', note: null })).status).toBe(403);
    const actions = await db.selectFrom('audit_events').select('action').where('action', 'in', ['bill.credited', 'bill.credit_downloaded', 'bill.delivered']).where('actor_id', '=', accounts.id).execute();
    expect(actions.map((event) => event.action).sort()).toEqual(['bill.credited', 'bill.delivered', 'bill.delivered']);
    expect(await db.selectFrom('audit_events').select('id').where('action', '=', 'bill.credit_downloaded').where('actor_id', '=', partner.id).where('resource_id', '=', credit.body.id).executeTakeFirst()).toBeDefined();
  });

  it('rolls back issue when its audit record fails', async () => {
    const draft = await createDraft();
    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    const failure = vi.spyOn(audit, 'record').mockImplementation((event, transaction) =>
      event.action === 'bill.issued' ? Promise.reject(new Error('audit unavailable')) : record(event, transaction),
    );
    let response: request.Response;
    try {
      response = await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`, {});
    } finally {
      failure.mockRestore();
    }
    expect(response!.status).toBe(500);
    expect(await db.selectFrom('issued_bills').select('id').where('draft_id', '=', draft.body.id).executeTakeFirst()).toBeUndefined();
  });
});
