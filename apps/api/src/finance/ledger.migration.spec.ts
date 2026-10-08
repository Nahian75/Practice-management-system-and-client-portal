import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('finance ledger database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accounts: TestAccount;
  let clientId: string;
  let matterId: string;
  let otherMatterId: string;
  let today: string;

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function openMatter(existingClient?: string): Promise<{ clientId: string; matterId: string }> {
    const selectedClient = existingClient ?? (await db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: 'Alex', family_name: uniqueName(),
        address_line1: '8 Ledger Lane', town: 'Leeds', postcode: 'LS1 1AA', country: 'GB',
      }).execute();
      return client.id;
    }));
    const check = await db.insertInto('conflict_checks').values({ client_id: selectedClient, requested_by: feeEarner.id, names: [uniqueName()] }).returning('id').executeTakeFirstOrThrow();
    const matter = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('matters').values({
        client_id: selectedClient, title: 'Ledger matter', matter_type: 'other',
        opened_by: feeEarner.id, conflict_check_id: check.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: row.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: row.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return row;
    });
    return { clientId: selectedClient, matterId: matter.id };
  }

  async function createBank(kind: 'client' | 'business' = 'client', actor = accounts.id, fingerprint = randomBytes(32), openedOn = today): Promise<string> {
    return (await sql<{ id: string }>`select app.create_bank_account(
      ${kind}, ${`${kind} account ${uniqueName()}`}, '5678', ${randomUUID()}::uuid,
      ${fingerprint}, 1::smallint, ${randomBytes(12)}, ${randomBytes(20)}, ${randomBytes(16)},
      ${openedOn}::date, ${actor}
    ) as id`.execute(db)).rows[0]!.id;
  }

  async function receipt(bankId: string, targetMatter = matterId, amount = '10000', reference = uniqueName(), actor = accounts.id): Promise<string> {
    return (await sql<{ id: string }>`select app.record_finance_receipt(
      ${bankId}, ${targetMatter}, ${today}::date, ${amount}::bigint,
      ${reference}, 'Funds received for the matter', ${actor}
    ) as id`.execute(db)).rows[0]!.id;
  }

  async function allocation(
    side: 'client' | 'business', amount: string, source = matterId, target = otherMatterId,
    actor = accounts.id, executor: Kysely<Database> = db,
  ): Promise<string> {
    return (await sql<{ id: string }>`select app.record_finance_allocation(
      ${side}, ${source}, ${target}, ${amount}::bigint, 'Correcting the matter allocation', ${actor}
    ) as id`.execute(executor)).rows[0]!.id;
  }

  async function issueBill(): Promise<{ billId: string; lineId: string }> {
    const supplier = {
      name: 'Stass Legal LLP', address_line1: '1 Justice Street', address_line2: null,
      town: 'London', postcode: 'SW1A 1AA', country: 'GB', vat_registration_number: 'GB123456789',
    };
    const lines = [{ kind: 'fee', description: 'Professional fees', net_pence: '10000', vat_treatment: 'standard', time_entry_id: null }];
    const draft = (await sql<{ id: string }>`select app.create_bill_draft(
      ${matterId}, ${today}::date, ${today}::date, ${JSON.stringify(supplier)}::jsonb,
      ${JSON.stringify(lines)}::jsonb, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    const billId = (await sql<{ id: string }>`select app.issue_bill(${draft}, ${accounts.id}) as id`.execute(db)).rows[0]!.id;
    const lineId = (await db.selectFrom('issued_bill_lines').select('id').where('bill_id', '=', billId).executeTakeFirstOrThrow()).id;
    return { billId, lineId };
  }

  beforeAll(() => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await db.destroy();
  });

  beforeEach(async () => {
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    accounts = await staffWith('accounts');
    ({ clientId, matterId } = await openMatter());
    otherMatterId = (await openMatter(clientId)).matterId;
  });

  it('creates an encrypted bank record through a narrow function and keeps only safe display fields plaintext', async () => {
    const id = await createBank();
    const row = await db.selectFrom('bank_accounts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    expect(row).toMatchObject({ id, kind: 'client', last_four: '5678', key_version: 1, created_by: accounts.id });
    expect(row.nonce).toHaveLength(12);
    expect(row.auth_tag).toHaveLength(16);
    expect(row.fingerprint).toHaveLength(32);
    expect(row.ciphertext.toString('utf8')).not.toContain('12345678');
  });

  it('requires a live Accounts actor, valid dates and unique encrypted bank details', async () => {
    await expect(createBank('client', feeEarner.id)).rejects.toThrow(/active accounts/i);
    await revokeTestRole(db, accounts.id, 'accounts');
    await expect(createBank()).rejects.toThrow(/active accounts/i);
    await grantTestRole(db, accounts.id, 'accounts');
    await setAccountStatus(db, accounts.id, 'disabled');
    await expect(createBank()).rejects.toThrow(/active accounts/i);
    await setAccountStatus(db, accounts.id, 'active');
    const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await expect(createBank('client', accounts.id, randomBytes(32), tomorrow.toISOString().slice(0, 10))).rejects.toThrow(/future/i);
    const fingerprint = randomBytes(32);
    await createBank('client', accounts.id, fingerprint);
    await expect(createBank('business', accounts.id, fingerprint)).rejects.toThrow(/unique/i);
  });

  it('records permanent closure history and permits only receipts dated within it', async () => {
    const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const closedOn = yesterday.toISOString().slice(0, 10);
    const bankId = await createBank('client', accounts.id, randomBytes(32), closedOn);
    const closureId = (await sql<{ id: string }>`select app.close_bank_account(
      ${bankId}, ${closedOn}::date, 'The account was replaced', ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    expect(closureId).toEqual(expect.any(String));
    await expect(sql`select app.close_bank_account(${bankId}, ${closedOn}::date, 'Again', ${accounts.id})`.execute(db)).rejects.toThrow(/already closed/i);
    await expect(sql`update bank_account_closures set reason = 'Changed' where id = ${closureId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);

    expect((await sql<{ id: string }>`select app.record_finance_receipt(
      ${bankId}, ${matterId}, ${closedOn}::date, 100::bigint,
      ${uniqueName()}, 'Final-day receipt', ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id).toEqual(expect.any(String));
    await expect(sql`select app.record_finance_receipt(
      ${bankId}, ${matterId}, ${today}::date, 100::bigint,
      ${uniqueName()}, 'Late receipt', ${accounts.id}
    )`.execute(db)).rejects.toThrow(/outside the bank account history/i);
  });

  it('posts client and business receipts as balanced cash-book and matter-ledger entries', async () => {
    const clientBank = await createBank('client');
    const businessBank = await createBank('business');
    const clientReceipt = await receipt(clientBank, matterId, '10003');
    const businessReceipt = await receipt(businessBank, matterId, '2500');
    const postings = await db.selectFrom('finance_postings').select(['transaction_id', 'account', 'direction', 'amount_pence'])
      .where('transaction_id', 'in', [clientReceipt, businessReceipt]).orderBy('transaction_id').orderBy('position').execute();

    expect(postings.filter((row) => row.transaction_id === clientReceipt)).toEqual([
      { transaction_id: clientReceipt, account: 'client_bank', direction: 'debit', amount_pence: '10003' },
      { transaction_id: clientReceipt, account: 'client_ledger', direction: 'credit', amount_pence: '10003' },
    ]);
    expect(postings.filter((row) => row.transaction_id === businessReceipt)).toEqual([
      { transaction_id: businessReceipt, account: 'business_bank', direction: 'debit', amount_pence: '2500' },
      { transaction_id: businessReceipt, account: 'business_ledger', direction: 'credit', amount_pence: '2500' },
    ]);
  });

  it('refuses duplicate references, invalid actors, future receipts and matters awaiting clearance', async () => {
    const bankId = await createBank();
    const reference = uniqueName();
    await receipt(bankId, matterId, '100', reference);
    await expect(receipt(bankId, matterId, '100', reference)).rejects.toThrow(/unique/i);
    await expect(receipt(bankId, matterId, '100', uniqueName(), feeEarner.id)).rejects.toThrow(/active accounts/i);
    const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await expect(sql`select app.record_finance_receipt(
      ${bankId}, ${matterId}, ${tomorrow.toISOString().slice(0, 10)}::date, 100::bigint,
      ${uniqueName()}, 'Future receipt', ${accounts.id}
    )`.execute(db)).rejects.toThrow(/history/i);
    await sql`update matters set status = 'awaiting_clearance' where id = ${matterId}`.execute(ownerDb);
    await expect(receipt(bankId)).rejects.toThrow(/open or closed matter/i);
  });

  it('moves client money only between matters for the same client and never below zero', async () => {
    const bankId = await createBank();
    await receipt(bankId, matterId, '10000');
    const id = await allocation('client', '4000');
    expect(await db.selectFrom('finance_postings').select(['matter_id', 'direction', 'amount_pence'])
      .where('transaction_id', '=', id).orderBy('position').execute()).toEqual([
      { matter_id: matterId, direction: 'debit', amount_pence: '4000' },
      { matter_id: otherMatterId, direction: 'credit', amount_pence: '4000' },
    ]);
    await expect(allocation('client', '6001')).rejects.toThrow(/insufficient client money/i);
    await expect(allocation('client', '1', matterId, matterId)).rejects.toThrow(/different matters/i);
    const foreignMatter = (await openMatter()).matterId;
    await expect(allocation('client', '1', matterId, foreignMatter)).rejects.toThrow(/between clients/i);
  });

  it('serialises concurrent client allocations so they cannot overspend one balance', async () => {
    const bankId = await createBank();
    await receipt(bankId, matterId, '10000');
    let firstPosted!: () => void;
    let finishFirst!: () => void;
    const posted = new Promise<void>((resolve) => (firstPosted = resolve));
    const finish = new Promise<void>((resolve) => (finishFirst = resolve));
    const first = db.transaction().execute(async (trx) => {
      const id = await allocation('client', '6000', matterId, otherMatterId, accounts.id, trx);
      firstPosted();
      await finish;
      return id;
    });
    await posted;
    const second = allocation('client', '6000');
    const early = await Promise.race([
      second.then(() => 'finished', () => 'finished'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
    ]);
    finishFirst();
    const outcomes = await Promise.allSettled([first, second]);
    expect(early).toBe('waiting');
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringMatching(/insufficient client money/i) }),
    });
  });

  it('records business allocation corrections without crossing into client money', async () => {
    const businessBank = await createBank('business');
    await receipt(businessBank, matterId, '5000');
    const id = await allocation('business', '2000');
    expect(await db.selectFrom('finance_postings').select(['account', 'matter_id', 'direction'])
      .where('transaction_id', '=', id).orderBy('position').execute()).toEqual([
      { account: 'business_ledger', matter_id: matterId, direction: 'debit' },
      { account: 'business_ledger', matter_id: otherMatterId, direction: 'credit' },
    ]);
  });

  it('posts issued bills and credit notes automatically to the business ledger', async () => {
    const { billId, lineId } = await issueBill();
    const billTransaction = await db.selectFrom('finance_transactions').selectAll().where('source_bill_id', '=', billId).executeTakeFirstOrThrow();
    expect(billTransaction).toMatchObject({ kind: 'bill', matter_id: matterId, amount_pence: '12000' });
    const creditId = (await sql<{ id: string }>`select app.issue_credit_note(
      ${billId}, 'The agreed fee was reduced',
      ${JSON.stringify([{ bill_line_id: lineId, net_pence: '1000' }])}::jsonb, ${accounts.id}
    ) as id`.execute(db)).rows[0]!.id;
    expect(await db.selectFrom('finance_transactions').select(['kind', 'amount_pence'])
      .where('source_credit_note_id', '=', creditId).executeTakeFirstOrThrow()).toEqual({ kind: 'credit_note', amount_pence: '1200' });
  });

  it('rejects owner-created unbalanced, mismatched and negative ledger transactions at commit', async () => {
    await expect(ownerDb.transaction().execute(async (trx) => {
      await sql`insert into finance_transactions (
        kind, client_id, matter_id, related_matter_id, purpose, amount_pence, occurred_on, posted_by
      ) values ('client_allocation', ${clientId}, ${matterId}, ${otherMatterId}, 'Unbalanced', 100, ${today}::date, ${accounts.id})`.execute(trx);
    })).rejects.toThrow(/balanced postings/i);

    const foreignMatter = (await openMatter()).matterId;
    await expect(ownerDb.transaction().execute(async (trx) => {
      const transactionId = (await sql<{ id: string }>`insert into finance_transactions (
        kind, client_id, matter_id, related_matter_id, purpose, amount_pence, occurred_on, posted_by
      ) values ('business_allocation', ${clientId}, ${matterId}, ${foreignMatter}, 'Mismatched client', 100, ${today}::date, ${accounts.id}) returning id`.execute(trx)).rows[0]!.id;
      await sql`insert into finance_postings (
        transaction_id, position, account, direction, amount_pence, client_id, matter_id
      ) values
        (${transactionId}, 1, 'business_ledger', 'debit', 100, ${clientId}, ${matterId}),
        (${transactionId}, 2, 'business_ledger', 'credit', 100, ${clientId}, ${foreignMatter})`.execute(trx);
    })).rejects.toThrow(/client and matter links/i);

    const bankId = await createBank();
    await receipt(bankId, matterId, '100');
    await expect(ownerDb.transaction().execute(async (trx) => {
      const transactionId = (await sql<{ id: string }>`insert into finance_transactions (
        kind, client_id, matter_id, related_matter_id, purpose, amount_pence, occurred_on, posted_by
      ) values ('client_allocation', ${clientId}, ${matterId}, ${otherMatterId}, 'Too much', 101, ${today}::date, ${accounts.id}) returning id`.execute(trx)).rows[0]!.id;
      await sql`insert into finance_postings (
        transaction_id, position, account, direction, amount_pence, client_id, matter_id
      ) values
        (${transactionId}, 1, 'client_ledger', 'debit', 101, ${clientId}, ${matterId}),
        (${transactionId}, 2, 'client_ledger', 'credit', 101, ${clientId}, ${otherMatterId})`.execute(trx);
    })).rejects.toThrow(/cannot become negative/i);
  });

  it('gives the application no direct writes and keeps every register and posting owner-immutable', async () => {
    const bankId = await createBank();
    const transactionId = await receipt(bankId);
    await expect(sql`insert into finance_transactions (
      kind, client_id, matter_id, related_matter_id, purpose, amount_pence, occurred_on, posted_by
    ) values ('client_allocation', ${clientId}, ${matterId}, ${otherMatterId}, 'Chosen', 1, ${today}::date, ${accounts.id})`.execute(db)).rejects.toThrow(/permission denied/i);
    await expect(sql`update bank_accounts set name = 'Changed' where id = ${bankId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`delete from finance_transactions where id = ${transactionId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    await expect(sql`truncate finance_postings, finance_transactions, bank_account_closures, bank_accounts cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
  });
});
