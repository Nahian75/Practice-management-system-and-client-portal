import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMatterForTests } from '../../test/aml.js';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { FinanceModule } from './finance.module.js';

@Module({ imports: [FinanceModule] })
class PaymentTestModule {}

describe('client payment API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let requester: TestAccount;
  let approver: TestAccount;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let requesterToken: string;
  let approverToken: string;
  let matterId: string;
  let evidenceDocumentId: string;
  let clientBankAccountId: string;
  let today: string;
  const unique = () => randomUUID().replaceAll('-', '').slice(0, 16);
  const cookie = (token: string) => `__Host-session=${token}`;
  const signedIn = (account: TestAccount) => sessions.start(account, 'authenticated', {});
  const as = (token: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(token)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(token)).send(body),
    };
  };

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function setupMatter() {
    const matterId = await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: 'API', family_name: unique(), address_line1: '2 Client Road',
        town: 'Leeds', postcode: 'LS1 1AA', country: 'GB',
      }).execute();
      const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [unique()] }).returning('id').executeTakeFirstOrThrow();
      const matter = await trx.insertInto('matters').values({ client_id: client.id, title: 'API payment', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return matter.id;
    });
    // The evidence is an ordinary matter document, so it follows clearance.
    await clearMatterForTests(db, matterId);
    return db.transaction().execute(async (trx) => {
      const document = await trx.insertInto('documents').values({ matter_id: matterId, title: 'Authority', category: 'evidence', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('document_versions').values({
        document_id: document.id, file_name: 'authority.pdf', media_type: 'application/pdf', size_bytes: 123,
        sha256: randomBytes(32), storage_key: randomUUID(), key_version: 1, key_nonce: randomBytes(12),
        wrapped_key: randomBytes(32), key_tag: randomBytes(16), uploaded_by: feeEarner.id,
      }).execute();
      return { matterId, evidenceId: document.id };
    });
  }

  const requestBody = () => ({
    kind: 'refund', matterId, clientBankAccountId, evidenceDocumentId,
    purpose: 'Return surplus funds', amount: '40.00',
    payee: { name: 'Morgan Client', sortCode: '12-34-56', accountNumber: '12345678' },
  });

  beforeAll(async () => {
    app = await createTestApp(PaymentTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });
  afterAll(async () => app.close());

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    requester = await staffWith('accounts');
    approver = await staffWith('accounts');
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    requesterToken = await signedIn(requester);
    approverToken = await signedIn(approver);
    const matter = await setupMatter();
    matterId = matter.matterId;
    evidenceDocumentId = matter.evidenceId;
    const bank = await as(requesterToken).post('/finance/bank-accounts', {
      kind: 'client', name: `Client ${unique()}`, sortCode: '12-34-56',
      accountNumber: randomInt(10_000_000, 100_000_000).toString(), openedOn: today,
    });
    clientBankAccountId = bank.body.id;
    await as(requesterToken).post('/finance/receipts', {
      bankAccountId: clientBankAccountId, matterId, receivedOn: today,
      amount: '100.00', reference: unique(), purpose: 'Funds on account',
    });
  });

  it('runs the four-eyes request, approval and paid workflow with safe representations', async () => {
    const created = await as(requesterToken).post('/finance/payment-requests', requestBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ kind: 'refund', status: 'pending', amount: '40.00', events: [] });
    expect(JSON.stringify(created.body)).not.toContain('12345678');
    expect(JSON.stringify(created.body)).not.toContain('sortCode');

    expect((await as(requesterToken).post(`/finance/payment-requests/${created.body.id}/approve`, {})).status).toBe(409);
    const approved = await as(approverToken).post(`/finance/payment-requests/${created.body.id}/approve`, {});
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('approved');

    const payee = await as(requesterToken).get(`/finance/payment-requests/${created.body.id}/payee`);
    expect(payee.status).toBe(200);
    expect(payee.body).toEqual(requestBody().payee);

    const paid = await as(requesterToken).post(`/finance/payment-requests/${created.body.id}/paid`, { bankReference: unique(), occurredOn: today });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.events.at(-1)).toMatchObject({ kind: 'paid', occurredOn: today });
    expect((await as(requesterToken).get(`/finance/payment-requests/${created.body.id}/payee`)).status).toBe(409);
  });

  it('keeps payee details encrypted and absent from lists and audit', async () => {
    const created = await as(requesterToken).post('/finance/payment-requests', requestBody());
    const stored = await db.selectFrom('client_payment_requests').selectAll().where('id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(stored.payee_ciphertext?.toString('utf8')).not.toContain('Morgan Client');
    expect(stored.payee_ciphertext?.toString('utf8')).not.toContain('12345678');
    const listed = await as(approverToken).get('/finance/payment-requests');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain('12345678');
    expect(JSON.stringify(listed.body)).not.toContain('Morgan Client');
    const audit = await db.selectFrom('audit_events').select('metadata').where('resource_id', '=', created.body.id).execute();
    expect(JSON.stringify(audit)).not.toContain('Morgan Client');
    expect(JSON.stringify(audit)).not.toContain('12345678');
  });

  it('enforces route permissions and strict request shapes', async () => {
    const partnerToken = await signedIn(partner);
    expect((await as(partnerToken).post('/finance/payment-requests', requestBody())).status).toBe(403);
    expect((await as(partnerToken).get('/finance/payment-requests')).status).toBe(403);
    expect((await as(requesterToken).post('/finance/payment-requests', { ...requestBody(), unexpected: true })).status).toBe(400);
    expect((await as(requesterToken).post('/finance/payment-requests', { ...requestBody(), amount: '0.00' })).status).toBe(400);
    expect((await as(requesterToken).post('/finance/payment-requests', { ...requestBody(), payee: { ...requestBody().payee, accountNumber: '1234' } })).status).toBe(400);
  });

  it('supports rejection and requester-only cancellation as terminal events', async () => {
    const rejected = await as(requesterToken).post('/finance/payment-requests', requestBody());
    expect((await as(approverToken).post(`/finance/payment-requests/${rejected.body.id}/reject`, { reason: 'Evidence is unclear' })).body.status).toBe('rejected');
    expect((await as(requesterToken).post(`/finance/payment-requests/${rejected.body.id}/approve`, {})).status).toBe(409);

    const cancelled = await as(requesterToken).post('/finance/payment-requests', requestBody());
    expect((await as(approverToken).post(`/finance/payment-requests/${cancelled.body.id}/cancel`, { reason: 'Not mine' })).status).toBe(409);
    expect((await as(requesterToken).post(`/finance/payment-requests/${cancelled.body.id}/cancel`, { reason: 'No longer needed' })).body.status).toBe('cancelled');
  });

  it('audits refused self-approval without recording private request data', async () => {
    const created = await as(requesterToken).post('/finance/payment-requests', requestBody());
    await as(requesterToken).post(`/finance/payment-requests/${created.body.id}/approve`, {});
    const denied = await db.selectFrom('audit_events').selectAll()
      .where('action', '=', 'finance.client_money_payment_approved').where('outcome', '=', 'denied')
      .where('resource_id', '=', created.body.id).executeTakeFirstOrThrow();
    expect(denied.metadata).toEqual({ attemptedEvent: 'approved' });
  });

  it('rolls back requests and approvals when their audit record fails', async () => {
    const audit = app.get(AuditService);
    const failedRequestPurpose = `Rollback ${unique()}`;
    const createSpy = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit unavailable'));
    expect((await as(requesterToken).post('/finance/payment-requests', { ...requestBody(), purpose: failedRequestPurpose })).status).toBe(500);
    createSpy.mockRestore();
    expect(await db.selectFrom('client_payment_requests').select('id').where('purpose', '=', failedRequestPurpose).executeTakeFirst()).toBeUndefined();

    const created = await as(requesterToken).post('/finance/payment-requests', requestBody());
    const approveSpy = vi.spyOn(audit, 'record').mockRejectedValue(new Error('audit unavailable'));
    expect((await as(approverToken).post(`/finance/payment-requests/${created.body.id}/approve`, {})).status).toBe(500);
    approveSpy.mockRestore();
    expect(await db.selectFrom('client_payment_events').select('id').where('payment_request_id', '=', created.body.id).executeTakeFirst()).toBeUndefined();
  });
});
