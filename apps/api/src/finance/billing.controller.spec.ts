import { randomBytes, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMatterForTests, imposeTestHold } from '../../test/aml.js';
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
    await clearMatterForTests(db, matter.id);
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
  const expenseBody=(changes:object={})=>({requestId:randomUUID(),incurredOn:today,kind:'recharge',description:'Travel for a client meeting',net:'10.03',vatTreatment:'standard',billable:true,receiptVersionId:null,...changes});
  const addExpense=(changes:object={})=>as(partnerToken).post(`/matters/${matterId}/expenses`,expenseBody(changes));
  const expenseLine=(id:string,changes:object={})=>({expenseEntryId:id,timeEntryId:null,kind:'recharge',description:'Travel for a client meeting',net:'10.03',vatTreatment:'standard',...changes});

  beforeAll(async () => {
    app = await createTestApp(BillingTestModule);
    db = app.get(DATABASE);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => app?.close());

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
    expect(downloaded.text).toContain('Quantity/extent 1 | Unit price £100.03');
    expect(downloaded.text).toContain('VAT 20% £20.01');
    expect(downloaded.text).toContain('VAT breakdown\n20% | Net £100.03 | VAT £20.01');
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
    expect(credit.body).toMatchObject({
      reference: expect.stringMatching(/^CRN-/), billId: bill.body.id,
      net: '10.00', vat: '2.00', gross: '12.00', lines: [{ vatTreatment: 'standard' }],
    });
    expect((await as(partnerToken).get(`/credit-notes/${credit.body.id}`)).status).toBe(200);
    const content = await as(partnerToken).get(`/credit-notes/${credit.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.text).toContain(`Original bill: ${bill.body.reference}`);
    expect(content.text).toContain(`Issue date: ${today}`);
    expect(content.text).toContain('Supplier: Stass Legal LLP');
    expect(content.text).toContain('Quantity/extent 1 | Unit credit £10.00');
    expect(content.text).toContain('VAT 20% £2.00');
    expect(content.text).toContain('VAT breakdown\n20% | Net £10.00 | VAT £2.00');
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

  it('records exact expenses once across concurrent retries and restricts each role and matter',async()=>{
    const input=expenseBody();
    expect((await request(app.getHttpServer()).get(`/matters/${matterId}/expenses`)).status).toBe(401);
    const responses=await Promise.all([as(partnerToken).post(`/matters/${matterId}/expenses`,input),as(partnerToken).post(`/matters/${matterId}/expenses`,input)]);
    expect(responses.map(r=>r.status)).toEqual([201,201]);expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    const id=responses[0]!.body.id;
    const listed=await as(partnerToken).get(`/matters/${matterId}/expenses`);expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({canRecord:true,matterOpen:true,expenses:[{id,net:'10.03',billable:true,void:null,billId:null}]});
    expect((await as(accountsToken).get(`/matters/${matterId}/expenses`)).body.expenses).toHaveLength(1);
    expect((await as(await signedIn(compliance)).get(`/matters/${matterId}/expenses`)).body.canRecord).toBe(false);
    expect((await as(await signedIn(compliance)).post(`/matters/${matterId}/expenses`,expenseBody())).status).toBe(403);
    expect((await as(await signedIn(outsider)).get(`/matters/${matterId}/expenses`)).status).toBe(404);
    expect((await as(await signedIn(outsider)).post(`/matters/${matterId}/expenses`,expenseBody())).status).toBe(404);
    const client=await createTestAccount(db,'client');expect((await as(await signedIn(client)).get(`/matters/${matterId}/expenses`)).status).toBe(403);
    expect((await as(accountsToken).post(`/matters/${matterId}/expenses`,expenseBody({billable:false,net:'7.50'}))).status).toBe(201);
    expect((await as(partnerToken).post(`/matters/${matterId}/expenses`,{...input,net:'10.04'})).status).toBe(409);
    const events=await db.selectFrom('audit_events').select(['metadata']).where('resource_id','=',id).where('action','=','expense.recorded').execute();
    expect(events).toEqual([{metadata:{matterId}}]);
    await expect(sql`UPDATE app.matter_expenses SET description='Silent overwrite' WHERE id=${id}::uuid`.execute(db)).rejects.toMatchObject({code:'42501'});
    await expect(sql`INSERT INTO app.matter_expense_voids(expense_id,reason,voided_by) VALUES(${id}::uuid,'Bypass',${partner.id}::uuid)`.execute(db)).rejects.toMatchObject({code:'42501'});
    await expect(sql`SELECT app.record_matter_expense(${matterId}::uuid,${today}::date,'recharge','Bypass',100::bigint,'standard',true,NULL,${randomUUID()}::uuid,${outsider.id}::uuid)`.execute(db)).rejects.toMatchObject({code:'42501'});
  });

  it('rejects unsafe expense input, unavailable receipts, future dates and missing clearance',async()=>{
    for(const changes of [{net:'0.00'},{net:'-1.00'},{net:'1.001'},{net:'1000000.01'},{description:'bad\u0000text'},{accountId:outsider.id},{receiptVersionId:'nope'}]){
      expect((await addExpense(changes)).status).toBe(400);
    }
    expect((await addExpense({incurredOn:'9999-12-31'})).status).toBe(409);
    expect((await addExpense({receiptVersionId:randomUUID()})).status).toBe(409);
    await imposeTestHold(db,{matterId},compliance.id);
    expect((await addExpense()).status).toBe(409);
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).status).toBe(200);
  });

  it('binds a receipt to an exact matter version without granting Accounts document access',async()=>{
    const version=async(documentId:string,trx:Kysely<Database>=db)=>trx.insertInto('document_versions').values({document_id:documentId,file_name:'receipt.pdf',media_type:'application/pdf',size_bytes:100,
      sha256:randomBytes(32),storage_key:randomUUID(),key_version:1,key_nonce:randomBytes(12),wrapped_key:randomBytes(32),key_tag:randomBytes(16),uploaded_by:partner.id}).returning('id').executeTakeFirstOrThrow();
    const {doc,first}=await db.transaction().execute(async trx=>{const doc=await trx.insertInto('documents').values({matter_id:matterId,title:'Travel receipt',category:'evidence',created_by:partner.id}).returning('id').executeTakeFirstOrThrow();return {doc,first:await version(doc.id,trx)};});
    const expense=await addExpense({receiptVersionId:first.id});expect(expense.status).toBe(201);
    const second=await version(doc.id);
    const options=await as(partnerToken).get(`/matters/${matterId}/expenses/receipt-options`);expect(options.status).toBe(200);
    expect(options.body.receipts).toEqual([{id:second.id,documentId:doc.id,title:'Travel receipt',number:2}]);
    expect((await as(accountsToken).get(`/matters/${matterId}/expenses/receipt-options`)).body.receipts).toEqual([]);
    expect((await as(accountsToken).post(`/matters/${matterId}/expenses`,expenseBody({receiptVersionId:first.id}))).status).toBe(403);
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses[0].receiptVersionId).toBe(first.id);
    const another=await openMatter();expect((await as(partnerToken).post(`/matters/${another}/expenses`,expenseBody({receiptVersionId:first.id}))).status).toBe(409);
    await db.insertInto('document_withdrawals').values({document_id:doc.id,withdrawn_by:partner.id,reason:'Wrong receipt uploaded'}).execute();
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses/receipt-options`)).body.receipts).toEqual([]);
    expect((await addExpense({receiptVersionId:second.id})).status).toBe(409);
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses[0].receiptVersionId).toBe(first.id);
  });

  it('bills multiple expense and manual lines with exact VAT and rejects duplicate expense use',async()=>{
    const recharge=await addExpense();const disbursement=await addExpense({kind:'disbursement',description:'Court filing',net:'25.00',vatTreatment:'outside_scope'});
    const lines=[expenseLine(recharge.body.id),expenseLine(disbursement.body.id,{kind:'disbursement',description:'Court filing',net:'25.00',vatTreatment:'outside_scope'}),
      {kind:'fee',description:'Professional fees',net:'100.03',vatTreatment:'standard',timeEntryId:null}];
    const draft=await createDraft(accountsToken,{lines});expect(draft.status,JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({net:'135.06',vat:'22.02',gross:'157.08',lines:[{expenseEntryId:recharge.body.id},{expenseEntryId:disbursement.body.id},{expenseEntryId:null}]});
    const updated=await as(accountsToken).put(`/bill-drafts/${draft.body.id}`,body({lines}));expect(updated.status).toBe(200);
    const bill=await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`,{});expect(bill.status,JSON.stringify(bill.body)).toBe(201);
    expect(bill.body).toMatchObject({gross:'157.08',lines:[{expenseEntryId:recharge.body.id},{expenseEntryId:disbursement.body.id},{expenseEntryId:null}]});
    const expenses=await as(partnerToken).get(`/matters/${matterId}/expenses`);expect(expenses.body.expenses.every((e:{billId:string})=>e.billId===bill.body.id)).toBe(true);
    expect((await createDraft(accountsToken,{lines:[expenseLine(recharge.body.id)]})).status).toBe(409);
    expect((await as(partnerToken).post(`/matters/${matterId}/expenses/${recharge.body.id}/void`,{reason:'Cannot remove billed history'})).status).toBe(409);
  });

  it('serializes competing invoices so an expense is charged only once',async()=>{
    const expense=await addExpense();const lines=[expenseLine(expense.body.id)];
    const a=await createDraft(accountsToken,{lines}),b=await createDraft(accountsToken,{lines});expect(a.status).toBe(201);expect(b.status).toBe(201);
    const results=await Promise.all([as(accountsToken).post(`/bill-drafts/${a.body.id}/issue`,{}),as(accountsToken).post(`/bill-drafts/${b.body.id}/issue`,{})]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    expect(await db.selectFrom('issued_bill_lines').select('id').where('source_expense_entry_id','=',expense.body.id).execute()).toHaveLength(1);
  });

  it('combines recorded time and expenses in one invoice and preserves both source identities',async()=>{
    await db.insertInto('staff_rates').values({account_id:partner.id,hourly_rate_pence:'12000',effective_from:today,created_by:accounts.id}).execute();
    const time=await db.insertInto('time_entries').values({matter_id:matterId,worker_id:partner.id,recorded_by:partner.id,worked_on:today,minutes:5,description:'Five minutes of reviewed advice'}).returning('id').executeTakeFirstOrThrow();
    const expense=await addExpense();
    const lines=[{kind:'fee',description:'Reviewed advice',net:'10.00',vatTreatment:'standard',timeEntryId:time.id},expenseLine(expense.body.id)];
    const draft=await createDraft(accountsToken,{lines});expect(draft.status,JSON.stringify(draft.body)).toBe(201);
    const bill=await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`,{});expect(bill.status).toBe(201);
    expect(bill.body).toMatchObject({net:'20.03',vat:'4.01',gross:'24.04',lines:[{timeEntryId:time.id,expenseEntryId:null},{timeEntryId:null,expenseEntryId:expense.body.id}]});
    const repeat=await createDraft(accountsToken,{lines:[lines[0]]});expect(repeat.status).toBe(201);
    expect((await as(accountsToken).post(`/bill-drafts/${repeat.body.id}/issue`,{})).status).toBe(409);
  });

  it('serializes voiding against invoice issue without creating a billed-and-voided expense',async()=>{
    const expense=await addExpense();const draft=await createDraft(accountsToken,{lines:[expenseLine(expense.body.id)]});expect(draft.status).toBe(201);
    const [issued,voided]=await Promise.all([as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`,{}),
      as(partnerToken).post(`/matters/${matterId}/expenses/${expense.body.id}/void`,{reason:'Correct the expense before issue'})]);
    expect([issued.status,voided.status].sort()).toEqual([201,409]);
    const result=(await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses[0];
    expect(Boolean(result.billId)).not.toBe(Boolean(result.void));
  });

  it('refuses nonbillable, altered, duplicate and cross-matter sources and blocks a voided draft on issue',async()=>{
    const expense=await addExpense();const nonbillable=await addExpense({billable:false});
    for(const lines of [[expenseLine(nonbillable.body.id)],[expenseLine(expense.body.id,{net:'10.04'})],[expenseLine(expense.body.id),expenseLine(expense.body.id)]]){
      expect((await createDraft(accountsToken,{lines})).status).toBe(409);
    }
    const another=await openMatter();expect((await as(accountsToken).post(`/matters/${another}/bill-drafts`,body({lines:[expenseLine(expense.body.id)]}))).status).toBe(409);
    const draft=await createDraft(accountsToken,{lines:[expenseLine(expense.body.id)]});expect(draft.status).toBe(201);
    const voided=await as(partnerToken).post(`/matters/${matterId}/expenses/${expense.body.id}/void`,{reason:'Recorded against the wrong visit'});expect(voided.status).toBe(201);
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses.find((e:{id:string})=>e.id===expense.body.id).void.reason).toBe('Recorded against the wrong visit');
    expect((await as(accountsToken).post(`/bill-drafts/${draft.body.id}/issue`,{})).status).toBe(409);
    expect(await db.selectFrom('issued_bills').select('id').where('draft_id','=',draft.body.id).execute()).toHaveLength(0);
  });

  it('rolls back expense records and voids when auditing fails',async()=>{
    const audit=app.get(AuditService),original=audit.record.bind(audit);const input=expenseBody();
    const failure=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action.startsWith('expense.')?Promise.reject(new Error('audit unavailable')):original(event,trx));
    try{expect((await as(partnerToken).post(`/matters/${matterId}/expenses`,input)).status).toBe(500);}finally{failure.mockRestore();}
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses).toHaveLength(0);
    const expense=await as(partnerToken).post(`/matters/${matterId}/expenses`,input);expect(expense.status).toBe(201);
    const voidFailure=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action==='expense.voided'?Promise.reject(new Error('audit unavailable')):original(event,trx));
    try{expect((await as(partnerToken).post(`/matters/${matterId}/expenses/${expense.body.id}/void`,{reason:'An audited correction'})).status).toBe(500);}finally{voidFailure.mockRestore();}
    expect((await as(partnerToken).get(`/matters/${matterId}/expenses`)).body.expenses[0].void).toBeNull();
  });
});
