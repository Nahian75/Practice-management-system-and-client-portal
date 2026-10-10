import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('client payment database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let feeEarner: TestAccount;
  let partner: TestAccount;
  let requester: TestAccount;
  let approver: TestAccount;
  let clientId: string;
  let matterId: string;
  let clientBankId: string;
  let evidenceId: string;
  let today: string;
  const unique = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function createMatter(existingClientId?: string) {
    return db.transaction().execute(async (trx) => {
      const selectedClientId = existingClientId ?? (await (async () => {
        const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('client_individuals').values({
          client_id: client.id, given_names: 'Payment', family_name: unique(), address_line1: '1 Client Street',
          town: 'London', postcode: 'SW1A 1AA', country: 'GB',
        }).execute();
        return client.id;
      })());
      const check = await trx.insertInto('conflict_checks').values({ client_id: selectedClientId, requested_by: feeEarner.id, names: [unique()] }).returning('id').executeTakeFirstOrThrow();
      const matter = await trx.insertInto('matters').values({ client_id: selectedClientId, title: 'Payment matter', matter_type: 'other', opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return { clientId: selectedClientId, matterId: matter.id };
    });
  }

  async function createBank(kind: 'client' | 'business' = 'client', openedOn = today) {
    return (await sql<{ id: string }>`select app.create_bank_account(
      ${kind}, ${`${kind} ${unique()}`}, '5678', ${randomUUID()}::uuid, ${randomBytes(32)},
      1::smallint, ${randomBytes(12)}, ${randomBytes(20)}, ${randomBytes(16)}, ${openedOn}::date, ${requester.id}
    ) as id`.execute(db)).rows[0]!.id;
  }

  async function createEvidence() {
    return db.transaction().execute(async (trx) => {
      const document = await trx.insertInto('documents').values({ matter_id: matterId, title: 'Payment authority', category: 'evidence', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('document_versions').values({
        document_id: document.id, file_name: 'authority.pdf', media_type: 'application/pdf', size_bytes: 123,
        sha256: randomBytes(32), storage_key: randomUUID(), key_version: 1, key_nonce: randomBytes(12),
        wrapped_key: randomBytes(32), key_tag: randomBytes(16), uploaded_by: feeEarner.id,
      }).execute();
      return document.id;
    });
  }

  async function receipt(amount = '10000') {
    await sql`select app.record_finance_receipt(
      ${clientBankId}, ${matterId}, ${today}::date, ${amount}::bigint,
      ${unique()}, 'Funds on account', ${requester.id}
    )`.execute(db);
  }

  async function requestPayment(actor = requester.id, amount = '4000') {
    return (await sql<{ id: string }>`select app.create_client_payment_request(
      'refund', ${clientBankId}, null, ${matterId}, null, ${evidenceId}, 'Refund surplus funds',
      ${amount}::bigint, ${randomUUID()}::uuid, 1::smallint, ${randomBytes(12)},
      ${randomBytes(64)}, ${randomBytes(16)}, ${actor}
    ) as id`.execute(db)).rows[0]!.id;
  }

  async function event(id: string, kind: string, actor: string, details: { reason?: string; reference?: string; date?: string } = {}, executor: Kysely<Database> = db) {
    return sql`select app.record_client_payment_event(
      ${id}, ${kind}, ${details.reason ?? null}, ${details.reference ?? null},
      ${details.date ?? null}::date, ${actor}
    )`.execute(executor);
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });
  afterAll(async () => { await ownerDb.destroy(); await db.destroy(); });

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    feeEarner = await staffWith('fee_earner');
    partner = await staffWith('partner');
    requester = await staffWith('accounts');
    approver = await staffWith('accounts');
    ({ clientId, matterId } = await createMatter());
    clientBankId = await createBank();
    evidenceId = await createEvidence();
  });

  it('creates an insert-only encrypted request through the narrow function', async () => {
    const id = await requestPayment();
    const row = await db.selectFrom('client_payment_requests').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ id, client_id: clientId, matter_id: matterId, requested_by: requester.id, amount_pence: '4000' });
    expect(row.payee_nonce).toHaveLength(12);
    await expect(sql`insert into client_payment_requests (kind) values ('refund')`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`update client_payment_requests set purpose = 'changed' where id = ${id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('requires live Accounts actors and a current evidence document', async () => {
    await expect(requestPayment(feeEarner.id)).rejects.toThrow(/active accounts/i);
    await revokeTestRole(db, requester.id, 'accounts');
    await expect(requestPayment()).rejects.toThrow(/active accounts/i);
    await grantTestRole(db, requester.id, 'accounts');
    await db.insertInto('document_withdrawals').values({ document_id: evidenceId, reason: 'Authority revoked', withdrawn_by: feeEarner.id }).execute();
    await expect(requestPayment()).rejects.toThrow(/supporting evidence/i);
  });

  it('enforces four eyes and live funds while auditing state as immutable events', async () => {
    await receipt();
    const id = await requestPayment();
    await expect(event(id, 'approved', requester.id)).rejects.toThrow(/different accounts holder/i);
    await event(id, 'approved', approver.id);
    await expect(event(id, 'rejected', approver.id, { reason: 'Too late' })).rejects.toThrow(/pending request/i);
    await expect(sql`insert into client_payment_events (payment_request_id, kind, acted_by) values (${id}, 'approved', ${approver.id})`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`delete from client_payment_events where payment_request_id = ${id}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });

  it('prevents bank closure while approved and releases the reservation on requester cancellation', async () => {
    await receipt();
    const id = await requestPayment();
    await event(id, 'approved', approver.id);
    await expect(sql`select app.close_bank_account(
      ${clientBankId}, ${today}::date, 'Close it', ${requester.id}
    )`.execute(db)).rejects.toThrow(/approved payment/i);
    await expect(event(id, 'cancelled', approver.id, { reason: 'Not my request' })).rejects.toThrow(/only the requester/i);
    await event(id, 'cancelled', requester.id, { reason: 'No longer required' });
    await expect(sql`select app.close_bank_account(
      ${clientBankId}, ${today}::date, 'No longer used', ${requester.id}
    )`.execute(db)).resolves.toBeDefined();
  });

  it('reserves approved funds against another approval and allocations', async () => {
    await receipt('5000');
    const first = await requestPayment(requester.id, '4000');
    const second = await requestPayment(requester.id, '2000');
    await event(first, 'approved', approver.id);
    await expect(event(second, 'approved', approver.id)).rejects.toThrow(/insufficient unreserved/i);
    const other = await createMatter(clientId);
    await expect(sql`select app.record_finance_allocation(
      'client', ${matterId}, ${other.matterId}, 1001::bigint, 'Move funds', ${requester.id}
    )`.execute(db)).rejects.toThrow(/insufficient client money/i);
  });

  it('serialises concurrent approvals so two requests cannot reserve the same funds', async () => {
    await receipt('5000');
    const firstId = await requestPayment(requester.id, '4000');
    const secondId = await requestPayment(requester.id, '4000');
    let firstApproved!: () => void;
    let finishFirst!: () => void;
    const approved = new Promise<void>((resolve) => (firstApproved = resolve));
    const finish = new Promise<void>((resolve) => (finishFirst = resolve));
    const first = db.transaction().execute(async (trx) => {
      await event(firstId, 'approved', approver.id, {}, trx);
      firstApproved();
      await finish;
    });
    await approved;
    const second = event(secondId, 'approved', approver.id);
    const early = await Promise.race([
      second.then(() => 'finished', () => 'finished'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
    ]);
    finishFirst();
    const outcomes = await Promise.allSettled([first, second]);
    expect(early).toBe('waiting');
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/insufficient unreserved/i) }),
    });
  });

  it('orders an Accounts role revocation after an already-started approval', async () => {
    await receipt();
    const id = await requestPayment();
    let approvalChecked!: () => void;
    let finishApproval!: () => void;
    const checked = new Promise<void>((resolve) => (approvalChecked = resolve));
    const finish = new Promise<void>((resolve) => (finishApproval = resolve));
    const approval = db.transaction().execute(async (trx) => {
      await event(id, 'approved', approver.id, {}, trx);
      approvalChecked();
      await finish;
    });
    await checked;
    const revocation = revokeTestRole(db, approver.id, 'accounts');
    const early = await Promise.race([
      revocation.then(() => 'finished'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
    ]);
    finishApproval();
    await Promise.all([approval, revocation]);
    expect(early).toBe('waiting');
  });

  it('keeps approved reservations unavailable to a later client allocation', async () => {
    await receipt('5000');
    const id = await requestPayment(requester.id, '4000');
    await event(id, 'approved', approver.id);
    const other = await createMatter(clientId);
    await expect(sql`select app.record_finance_allocation(
      'client', ${matterId}, ${other.matterId}, 1001::bigint, 'Move funds', ${requester.id}
    )`.execute(db)).rejects.toThrow(/insufficient client money/i);
  });

  it('posts a paid refund once and releases a bank-rejected reservation without posting', async () => {
    await receipt();
    const paid = await requestPayment();
    await event(paid, 'approved', approver.id);
    await event(paid, 'paid', requester.id, { reference: unique(), date: today });
    const transaction = await db.selectFrom('finance_transactions').selectAll().where('source_payment_request_id', '=', paid).executeTakeFirstOrThrow();
    expect(transaction).toMatchObject({ kind: 'client_payment', amount_pence: '4000', bank_account_id: clientBankId });
    const postings = await db.selectFrom('finance_postings').select(['account', 'direction']).where('transaction_id', '=', transaction.id).orderBy('position').execute();
    expect(postings).toEqual([{ account: 'client_ledger', direction: 'debit' }, { account: 'client_bank', direction: 'credit' }]);
    await expect(event(paid, 'paid', requester.id, { reference: unique(), date: today })).rejects.toThrow(/approved request/i);

    const rejected = await requestPayment(requester.id, '5000');
    await event(rejected, 'approved', approver.id);
    await event(rejected, 'bank_rejected', requester.id, { reason: 'Bank refused it' });
    expect(await db.selectFrom('finance_transactions').select('id').where('source_payment_request_id', '=', rejected).executeTakeFirst()).toBeUndefined();
  });

  it('refuses a bank payment dated before its four-eyes approval', async () => {
    const yesterday = (await sql<{ day: string }>`select (${today}::date - 1)::text as day`.execute(db)).rows[0]!.day;
    clientBankId = await createBank('client', yesterday);
    await receipt();
    const id = await requestPayment();
    await event(id, 'approved', approver.id);
    await expect(event(id, 'paid', requester.id, {
      reference: unique(), date: yesterday,
    })).rejects.toThrow(/before approval/i);
    expect(await db.selectFrom('finance_transactions').select('id')
      .where('source_payment_request_id', '=', id).executeTakeFirst()).toBeUndefined();
  });

  it('requires an issued bill for a balanced costs transfer and protects paid costs from later credit', async () => {
    await receipt('20000');
    const businessBank = await createBank('business');
    const supplier = { name: 'Stass Legal LLP', address_line1: '1 Justice Street', address_line2: null, town: 'London', postcode: 'SW1A 1AA', country: 'GB', vat_registration_number: 'GB123456789' };
    const lines = [{ kind: 'fee', description: 'Professional fees', net_pence: '10000', vat_treatment: 'standard', time_entry_id: null }];
    const draft = (await sql<{ id: string }>`select app.create_bill_draft(${matterId}, ${today}::date, ${today}::date, ${JSON.stringify(supplier)}::jsonb, ${JSON.stringify(lines)}::jsonb, ${requester.id}) as id`.execute(db)).rows[0]!.id;
    const bill = (await sql<{ id: string }>`select app.issue_bill(${draft}, ${requester.id}) as id`.execute(db)).rows[0]!.id;
    const id = (await sql<{ id: string }>`select app.create_client_payment_request(
      'costs_transfer', ${clientBankId}, ${businessBank}, ${matterId}, ${bill}, ${evidenceId},
      'Transfer billed costs', 12000::bigint, null, null, null, null, null, ${requester.id}
    ) as id`.execute(db)).rows[0]!.id;
    await event(id, 'approved', approver.id);
    const excessive = (await sql<{ id: string }>`select app.create_client_payment_request(
      'costs_transfer', ${clientBankId}, ${businessBank}, ${matterId}, ${bill}, ${evidenceId},
      'Excess billed costs', 1::bigint, null, null, null, null, null, ${requester.id}
    ) as id`.execute(db)).rows[0]!.id;
    await expect(event(excessive, 'approved', approver.id)).rejects.toThrow(/bill amount/i);
    await event(id, 'paid', requester.id, { reference: unique(), date: today });
    const transaction = await db.selectFrom('finance_transactions').selectAll().where('source_payment_request_id', '=', id).executeTakeFirstOrThrow();
    expect(transaction).toMatchObject({ kind: 'costs_transfer', related_bank_account_id: businessBank });
    expect(await db.selectFrom('finance_postings').select('id').where('transaction_id', '=', transaction.id).execute()).toHaveLength(4);
    const line = await db.selectFrom('issued_bill_lines').select('id').where('bill_id', '=', bill).executeTakeFirstOrThrow();
    await expect(sql`select app.issue_credit_note(
      ${bill}, 'Cannot erase paid costs', ${JSON.stringify([{ bill_line_id: line.id, net_pence: '1' }])}::jsonb, ${requester.id}
    )`.execute(db)).rejects.toThrow(/paid costs/i);
  });
});
