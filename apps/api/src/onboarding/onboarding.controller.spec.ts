import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { waitForEmails } from '../../test/mailpit.js';
import { ensureAmlFramework, londonDates } from '../../test/aml.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { hashOpaqueToken } from '../common/crypto/opaque-token.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { OnboardingModule } from './onboarding.module.js';

@Module({ imports: [OnboardingModule] })
class OnboardingTestModule {}

describe('Contact verification API', () => {
  let app: NestExpressApplication;
  let db: Kysely<Database>;
  let sessions: SessionsService;
  let feeEarner: TestAccount;
  let outsider: TestAccount;
  let token: string;
  let outsiderToken: string;
  let clientId: string;
  let email: string;

  const cookie = (value: string) => `__Host-session=${value}`;
  const api = (value: string) => {
    const server = request(app.getHttpServer());
    return {
      get: (path: string) => server.get(path).set('Cookie', cookie(value)),
      post: (path: string, body: object) => server.post(path).set('Cookie', cookie(value)).send(body),
    };
  };

  beforeAll(async () => {
    app = await createTestApp(OnboardingTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });
  afterAll(async () => app.close());

  beforeEach(async () => {
    email = `verify-${randomUUID()}@example.com`;
    feeEarner = await createTestAccount(db, 'staff');
    outsider = await createTestAccount(db, 'staff');
    await grantTestRole(db, feeEarner.id, 'fee_earner');
    await grantTestRole(db, outsider.id, 'fee_earner');
    token = await sessions.start(feeEarner, 'authenticated', {});
    outsiderToken = await sessions.start(outsider, 'authenticated', {});
    clientId = await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({ client_id: client.id,
        given_names: 'Contact', family_name: 'Test', email }).execute();
      return client.id;
    });
  });

  async function requestLink() {
    const before = (await waitForEmails(email, 0)).length;
    const response = await api(token).post(`/clients/${clientId}/contact-verifications`, {});
    const messages = await waitForEmails(email, before + 1);
    const opaque = /#token=([A-Za-z0-9_-]{43})/.exec(messages.at(-1)?.text ?? '')?.[1];
    if (!opaque) throw new Error('No contact-verification token in the email');
    return { response, opaque, message: messages.at(-1)! };
  }

  it('sends a one-time fragment link and stores only its hash', async () => {
    const { response, opaque, message } = await requestLink();
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ clientId, contactId: null, channel: 'email', address: email,
      state: 'pending', attemptCount: 0, verifiedAt: null });
    expect(message.subject).toBe('Verify your email address');
    expect(message.text).toContain('/verify-contact#token=');
    expect(message.text).toContain('does not verify your identity');
    const stored = await db.selectFrom('contact_verification_requests').selectAll()
      .where('id', '=', response.body.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain(opaque);
    expect(stored.token_hash.equals(hashOpaqueToken(opaque))).toBe(true);
  });

  it('verifies exactly once and exposes the timestamp without calling it identity verification', async () => {
    const { response: created, opaque } = await requestLink();
    const completed = await request(app.getHttpServer()).post('/contact-verifications/complete').send({ token: opaque });
    expect(completed.status).toBe(200);
    expect(completed.body).toEqual({ verified: true });
    expect((await request(app.getHttpServer()).post('/contact-verifications/complete').send({ token: opaque })).status).toBe(404);
    const listed = await api(token).get(`/clients/${clientId}/contact-verifications`);
    expect(listed.status).toBe(200);
    expect(listed.body.verifications[0]).toMatchObject({ id: created.body.id, state: 'verified',
      attemptCount: 2, verifiedAt: expect.any(String) });
    const event = await db.selectFrom('audit_events').select(['action', 'metadata'])
      .where('resource_id', '=', created.body.id).where('action', '=', 'onboarding.contact_verified')
      .executeTakeFirstOrThrow();
    expect(event.metadata).toEqual({ channel: 'email' });
  });

  it('invalidates replaced links and links for an address that changed', async () => {
    const first = await requestLink();
    const second = await requestLink();
    expect((await request(app.getHttpServer()).post('/contact-verifications/complete').send({ token: first.opaque })).status).toBe(404);
    expect((await request(app.getHttpServer()).post('/contact-verifications/complete').send({ token: second.opaque })).status).toBe(200);

    const third = await requestLink();
    await db.updateTable('client_individuals').set({ email: `changed-${randomUUID()}@example.com` })
      .where('client_id', '=', clientId).execute();
    expect((await request(app.getHttpServer()).post('/contact-verifications/complete').send({ token: third.opaque })).status).toBe(404);
    const listed = await api(token).get(`/clients/${clientId}/contact-verifications`);
    expect(listed.body.verifications.find((item: { id: string }) => item.id === third.response.body.id).state)
      .toBe('address_changed');
  });

  it('hides another fee earner client and requires an organisation contact with email', async () => {
    expect((await api(outsiderToken).post(`/clients/${clientId}/contact-verifications`, {})).status).toBe(404);
    expect((await api(outsiderToken).get(`/clients/${clientId}/contact-verifications`)).status).toBe(404);

    const organisation = await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'organisation', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_organisations').values({ client_id: client.id,
        legal_name: `Company ${randomUUID()}`, organisation_type: 'company' }).execute();
      const contact = await trx.insertInto('client_contacts').values({ client_id: client.id,
        given_names: 'No', family_name: 'Email' }).returning('id').executeTakeFirstOrThrow();
      return { clientId: client.id, contactId: contact.id };
    });
    expect((await api(token).post(`/clients/${organisation.clientId}/contact-verifications`, {})).status).toBe(409);
    expect((await api(token).post(`/clients/${organisation.clientId}/contact-verifications`,
      { contactId: organisation.contactId })).status).toBe(409);
  });

  it('limits request bursts per client', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await api(token).post(`/clients/${clientId}/contact-verifications`, {})).status).toBe(201);
    }
    expect((await api(token).post(`/clients/${clientId}/contact-verifications`, {})).status).toBe(429);
  });

  it('accepts one requested portal file into protected CDD evidence and exposes no internal AML result', async () => {
    await ensureAmlFramework(db);
    const cdd = (await sql<{ id: string }>`select app.create_aml_cdd_case(${clientId},
      'Legal services requested by the client', 'Identity evidence required before accepting instructions',
      ${feeEarner.id}) as id`.execute(db)).rows[0]!.id;
    const portalAccount = await createTestAccount(db, 'client');
    await db.updateTable('client_individuals').set({ email: portalAccount.email })
      .where('client_id','=',clientId).execute();
    await db.insertInto('portal_links').values({ account_id: portalAccount.id, client_id: clientId,
      contact_id: null, linked_by: feeEarner.id }).execute();
    const portalToken = await sessions.start(portalAccount, 'authenticated', {});
    const { inAYear } = await londonDates(db);
    const created = await api(token).post(`/clients/${clientId}/cdd/${cdd}/evidence-requests`, {
      contactId: null, evidenceType: 'Passport', country: 'GB', dueOn: inAYear,
      instructions: 'Upload a clear copy of the current passport photograph page.',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.submission).toBeNull();

    const listed = await api(portalToken).get('/portal/evidence-requests');
    expect(listed.status).toBe(200);
    expect(listed.body.requests).toEqual([expect.objectContaining({ id: created.body.id,
      evidenceType: 'Passport', state: 'open' })]);
    expect(JSON.stringify(listed.body)).not.toContain(cdd);
    expect(JSON.stringify(listed.body)).not.toContain(clientId);

    const uploaded = await request(app.getHttpServer()).post(`/portal/evidence-requests/${created.body.id}/submission`)
      .set('Cookie', cookie(portalToken)).attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'passport.pdf');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body).toMatchObject({ id: created.body.id, state: 'submitted', submittedAt: expect.any(String) });
    expect((await request(app.getHttpServer()).post(`/portal/evidence-requests/${created.body.id}/submission`)
      .set('Cookie', cookie(portalToken)).attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), 'again.pdf')).status).toBe(409);

    const staffView = await api(token).get(`/clients/${clientId}/cdd/${cdd}/evidence-requests`);
    expect(staffView.body.requests[0].submission).toMatchObject({ uploadedBy: { accountId: portalAccount.id } });
    const evidence = await db.selectFrom('aml_cdd_evidence').select(['uploaded_by','storage_key'])
      .where('id','=',staffView.body.requests[0].submission.evidenceId).executeTakeFirstOrThrow();
    expect(evidence.uploaded_by).toBe(portalAccount.id);
    expect(evidence.storage_key).toMatch(/^compliance\//);

    // Review evidence submission
    const reviewRes = await api(token).post(`/clients/${clientId}/cdd/${cdd}/evidence-reviews`, {
      requestId: created.body.id,
      evidenceId: staffView.body.requests[0].submission.evidenceId,
      outcome: 'accepted',
      reason: 'Passport photograph page is legible and current',
    });
    expect(reviewRes.status, JSON.stringify(reviewRes.body)).toBe(201);
    expect(reviewRes.body).toMatchObject({ reviewId: expect.any(String), outcome: 'recorded' });

    // Duplicate review is rejected
    const dupReview = await api(token).post(`/clients/${clientId}/cdd/${cdd}/evidence-reviews`, {
      requestId: created.body.id,
      evidenceId: staffView.body.requests[0].submission.evidenceId,
      outcome: 'accepted',
      reason: 'Trying duplicate review',
    });
    expect(dupReview.status).toBe(409);

    const updatedStaffView = await api(token).get(`/clients/${clientId}/cdd/${cdd}/evidence-requests`);
    expect(updatedStaffView.body.requests[0].review).toMatchObject({
      outcome: 'accepted',
      reason: 'Passport photograph page is legible and current',
      reviewedBy: { accountId: feeEarner.id },
    });
  });

  it('records electronic checks and refuses future check dates', async () => {
    const rawVendorPayload = JSON.stringify({ check_id: 'chk_12345', status: 'clear' });
    const checkRes = await api(token).post(`/clients/${clientId}/electronic-checks`, {
      provider: 'LexisNexis',
      service: 'IDV_and_Sanctions',
      providerReference: 'LN-REF-9988',
      documentType: 'passport',
      checkDate: '2026-10-01',
      result: 'pass',
      livenessResult: 'pass',
      evidenceMatch: 'Name and DOB match client record',
      rawResponseJson: rawVendorPayload,
    });
    expect(checkRes.status, JSON.stringify(checkRes.body)).toBe(201);
    expect(checkRes.body).toMatchObject({ checkId: expect.any(String), outcome: 'recorded' });

    const checksList = await api(token).get(`/clients/${clientId}/electronic-checks`);
    expect(checksList.status).toBe(200);
    expect(checksList.body.checks).toEqual([
      expect.objectContaining({
        id: checkRes.body.checkId,
        provider: 'LexisNexis',
        service: 'IDV_and_Sanctions',
        result: 'pass',
        livenessResult: 'pass',
        documentType: 'passport',
        recordedBy: expect.objectContaining({ accountId: feeEarner.id }),
      }),
    ]);

    // Refuses future check date
    const futureCheck = await api(token).post(`/clients/${clientId}/electronic-checks`, {
      provider: 'LexisNexis',
      service: 'IDV_and_Sanctions',
      providerReference: 'LN-REF-9989',
      documentType: 'passport',
      checkDate: '2099-01-01',
      result: 'pass',
      rawResponseJson: rawVendorPayload,
    });
    expect(futureCheck.status).toBe(409);
  });

  it('reports Companies House status and records immutable company snapshots with discrepancies', async () => {
    const statusRes = await api(token).get(`/clients/${clientId}/companies-house/status`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toHaveProperty('configured');

    const orgClient = await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'organisation', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_organisations').values({
        client_id: client.id,
        legal_name: 'Acme Advisory Ltd',
        organisation_type: 'company',
        registration_number: '12345678',
      }).execute();
      return client.id;
    });

    const snapshotPayload = JSON.stringify({
      company_name: 'ACME ADVISORY HOLDINGS LIMITED',
      company_number: '12345678',
      company_status: 'active',
    });

    const recordRes = await api(token).post(`/clients/${orgClient}/company-snapshots`, {
      source: 'companies_house',
      companyNumber: '12345678',
      companyName: 'ACME ADVISORY HOLDINGS LIMITED',
      companyStatus: 'active',
      companyType: 'ltd',
      jurisdiction: 'england-wales',
      incorporationDate: '2020-05-15',
      registeredOffice: { address_line_1: '10 High Street', postal_code: 'EC1A 1BB' },
      officers: [{ name: 'Smith, John', officer_role: 'director' }],
      discrepancies: [{
        field: 'legal_name',
        clientValue: 'Acme Advisory Ltd',
        companiesHouseValue: 'ACME ADVISORY HOLDINGS LIMITED',
        description: 'Client registered name differs from Companies House',
      }],
      rawPayloadJson: snapshotPayload,
    });
    expect(recordRes.status, JSON.stringify(recordRes.body)).toBe(201);
    expect(recordRes.body).toMatchObject({ snapshotId: expect.any(String), outcome: 'recorded' });

    const snapshots = await api(token).get(`/clients/${orgClient}/company-snapshots`);
    expect(snapshots.status).toBe(200);
    expect(snapshots.body.snapshots).toEqual([
      expect.objectContaining({
        id: recordRes.body.snapshotId,
        companyNumber: '12345678',
        companyName: 'ACME ADVISORY HOLDINGS LIMITED',
        companyStatus: 'active',
        discrepancies: [
          expect.objectContaining({ field: 'legal_name' }),
        ],
        recordedBy: expect.objectContaining({ accountId: feeEarner.id }),
      }),
    ]);
  });
});

