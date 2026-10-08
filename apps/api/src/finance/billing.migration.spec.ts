import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, revokeTestRole, setAccountStatus, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

type LineInput = {
  kind: 'fee' | 'recharge' | 'disbursement';
  description: string;
  net_pence: string;
  vat_treatment: 'standard' | 'reduced' | 'zero' | 'exempt' | 'outside_scope';
  time_entry_id: string | null;
};

type SupplierInput = {
  name: string;
  address_line1: string;
  address_line2: string | null;
  town: string;
  postcode: string | null;
  country: string;
  vat_registration_number: string | null;
};

interface BillRow {
  id: string;
  number: string;
  reference: string;
  matter_reference: string;
  client_reference: string;
  client_name: string;
  supplier_name: string;
  net_pence: string;
  vat_pence: string;
  gross_pence: string;
  issued_at: Date;
}

describe('bill database rules', () => {
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let accounts: TestAccount;
  let matterId: string;
  let clientId: string;
  let timeEntryId: string;
  let today: string;

  const supplier: SupplierInput = {
    name: 'Stass Legal LLP',
    address_line1: '1 Justice Street',
    address_line2: null,
    town: 'London',
    postcode: 'SW1A 1AA',
    country: 'GB',
    vat_registration_number: 'GB123456789',
  };

  const uniqueName = () => randomUUID().replaceAll('-', '').slice(0, 16);

  async function staffWith(...roles: StaffRole[]): Promise<TestAccount> {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) {
      await grantTestRole(db, account.id, role);
    }
    return account;
  }

  async function openMatter(withAddress = true): Promise<{ matterId: string; clientId: string }> {
    const client = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: row.id,
        given_names: 'Jamie',
        family_name: uniqueName(),
        ...(withAddress ? { address_line1: '22 Client Road', town: 'Bristol', postcode: 'BS1 1AA', country: 'GB' } : {}),
      }).execute();
      return row;
    });
    const check = await db.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [uniqueName()] }).returning('id').executeTakeFirstOrThrow();
    const matter = await db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('matters').values({
        client_id: client.id,
        title: 'Bill database matter',
        matter_type: 'other',
        opened_by: feeEarner.id,
        conflict_check_id: check.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: row.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: row.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return row;
    });
    return { matterId: matter.id, clientId: client.id };
  }

  async function addTime(targetMatter = matterId): Promise<string> {
    await sql`
      insert into staff_rates (account_id, hourly_rate_pence, effective_from, created_by)
      values (${feeEarner.id}, 24000, ${today}::date, ${accounts.id})
      on conflict (account_id, effective_from) do nothing
    `.execute(db);
    return (await sql<{ id: string }>`
      insert into time_entries (matter_id, worker_id, worked_on, minutes, description, recorded_by)
      values (${targetMatter}, ${feeEarner.id}, ${today}::date, 90, 'Prepared the completion papers', ${feeEarner.id})
      returning id
    `.execute(db)).rows[0]!.id;
  }

  function lines(overrides: Partial<LineInput> = {}): LineInput[] {
    return [{
      kind: 'fee',
      description: 'Professional fees',
      net_pence: '10000',
      vat_treatment: 'standard',
      time_entry_id: timeEntryId,
      ...overrides,
    }];
  }

  async function createDraft(options: {
    targetMatter?: string;
    actor?: string;
    lineValues?: LineInput[];
    supplierValues?: SupplierInput;
    taxPoint?: string;
    dueOn?: string;
  } = {}): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_bill_draft(
      ${options.targetMatter ?? matterId},
      ${(options.taxPoint ?? today)}::date,
      ${(options.dueOn ?? today)}::date,
      ${JSON.stringify(options.supplierValues ?? supplier)}::jsonb,
      ${JSON.stringify(options.lineValues ?? lines())}::jsonb,
      ${options.actor ?? accounts.id}
    ) as id`.execute(db);
    return result.rows[0]!.id;
  }

  async function replaceDraft(draftId: string, options: { actor?: string; lineValues?: LineInput[]; supplierValues?: SupplierInput } = {}): Promise<void> {
    await sql`select app.replace_bill_draft(
      ${draftId}, ${today}::date, ${today}::date,
      ${JSON.stringify(options.supplierValues ?? supplier)}::jsonb,
      ${JSON.stringify(options.lineValues ?? lines({ description: 'Updated professional fees', net_pence: '12000' }))}::jsonb,
      ${options.actor ?? accounts.id}
    )`.execute(db);
  }

  async function issue(draftId: string, actor = accounts.id): Promise<string> {
    return (await sql<{ id: string }>`select app.issue_bill(${draftId}, ${actor}) as id`.execute(db)).rows[0]!.id;
  }

  async function credit(billId: string, billLineId: string, netPence: string, reason = 'The agreed fee was reduced', actor = accounts.id): Promise<string> {
    return (await sql<{ id: string }>`select app.issue_credit_note(
      ${billId}, ${reason}, ${JSON.stringify([{ bill_line_id: billLineId, net_pence: netPence }])}::jsonb, ${actor}
    ) as id`.execute(db)).rows[0]!.id;
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
    ({ matterId, clientId } = await openMatter());
    timeEntryId = await addTime();
  });

  describe('drafts', () => {
    it('creates and replaces a draft through narrow database functions', async () => {
      const draftId = await createDraft();
      const created = await sql<{ matter_id: string; created_by: string; updated_by: string; created_at: Date; updated_at: Date }>`
        select matter_id, created_by, updated_by, created_at, updated_at from bill_drafts where id = ${draftId}
      `.execute(db);
      expect(created.rows[0]).toEqual({
        matter_id: matterId,
        created_by: accounts.id,
        updated_by: accounts.id,
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      });
      await replaceDraft(draftId);
      expect((await sql<{ description: string; net_pence: string }>`select description, net_pence from bill_draft_lines where draft_id = ${draftId}`.execute(db)).rows).toEqual([
        { description: 'Updated professional fees', net_pence: '12000' },
      ]);
    });

    it('requires an active Accounts actor and an open matter', async () => {
      await expect(createDraft({ actor: feeEarner.id })).rejects.toThrow(/active accounts/i);
      await revokeTestRole(db, accounts.id, 'accounts');
      await expect(createDraft()).rejects.toThrow(/active accounts/i);
      await grantTestRole(db, accounts.id, 'accounts');
      await setAccountStatus(db, accounts.id, 'disabled');
      await expect(createDraft()).rejects.toThrow(/active accounts/i);
      await setAccountStatus(db, accounts.id, 'active');
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      await expect(createDraft()).rejects.toThrow(/open matter/i);
    });

    it('refuses bad dates, supplier details, line values and line shapes', async () => {
      const tomorrow = new Date(`${today}T12:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowText = tomorrow.toISOString().slice(0, 10);
      await expect(createDraft({ taxPoint: tomorrowText, dueOn: tomorrowText })).rejects.toThrow(/tax point/i);
      await expect(createDraft({ dueOn: '1900-01-01' })).rejects.toThrow(/due date/i);
      await expect(createDraft({ supplierValues: { ...supplier, name: '' } })).rejects.toThrow(/supplier/i);
      await expect(createDraft({ supplierValues: { ...supplier, vat_registration_number: null }, lineValues: lines() })).rejects.toThrow(/VAT registration/i);
      await expect(createDraft({ lineValues: [] })).rejects.toThrow(/between 1 and 100/i);
      await expect(createDraft({ lineValues: Array.from({ length: 101 }, (_, index) => lines({ description: `Line ${index + 1}`, time_entry_id: null })[0]!) })).rejects.toThrow(/between 1 and 100/i);
      await expect(createDraft({ lineValues: lines({ net_pence: '0' }) })).rejects.toThrow(/check constraint/i);
      await expect(createDraft({ lineValues: lines({ description: '' }) })).rejects.toThrow(/check constraint/i);
      await expect(createDraft({ lineValues: [{ ...lines()[0]!, unexpected: 'value' } as LineInput] })).rejects.toThrow(/line fields/i);
    });

    it('checks linked time belongs to the matter, is not void and is used only on a fee line', async () => {
      const other = await openMatter();
      const otherTime = await addTime(other.matterId);
      await expect(createDraft({ lineValues: lines({ time_entry_id: otherTime }) })).rejects.toThrow(/time entry/i);
      await expect(createDraft({ lineValues: lines({ kind: 'recharge' }) })).rejects.toThrow(/time entry/i);
      await sql`insert into time_entry_corrections (time_entry_id, reason, corrected_by) values (${timeEntryId}, 'Entered on the wrong matter', ${feeEarner.id})`.execute(db);
      await expect(createDraft()).rejects.toThrow(/time entry/i);
    });

    it('gives the app no direct table writes and locks a draft after issue', async () => {
      const draftId = await createDraft();
      await expect(sql`insert into bill_drafts (matter_id, tax_point, due_on, supplier_name, supplier_address_line1, supplier_town, supplier_country, created_by, updated_by) values (${matterId}, ${today}::date, ${today}::date, 'Chosen', 'Street', 'Town', 'GB', ${accounts.id}, ${accounts.id})`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update bill_drafts set supplier_name = 'Changed' where id = ${draftId}`.execute(db)).rejects.toThrow(/permission denied/i);
      await issue(draftId);
      await expect(replaceDraft(draftId)).rejects.toThrow(/issued draft/i);
      await expect(sql`update bill_drafts set supplier_name = 'Owner changed' where id = ${draftId}`.execute(ownerDb)).rejects.toThrow(/issued draft/i);
      await expect(sql`delete from bill_draft_lines where draft_id = ${draftId}`.execute(ownerDb)).rejects.toThrow(/issued draft/i);
      await expect(sql`insert into bill_draft_lines (draft_id, position, kind, description, net_pence, vat_treatment) values (${draftId}, 2, 'fee', 'Owner line', 100, 'standard')`.execute(ownerDb)).rejects.toThrow(/issued draft/i);
      await expect(sql`truncate bill_draft_lines cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });

  describe('issued bills', () => {
    it('assigns a permanent sequential number and snapshots names, references, time and totals', async () => {
      const draftId = await createDraft({ lineValues: [
        ...lines(),
        { kind: 'disbursement', description: 'Land Registry fee', net_pence: '2500', vat_treatment: 'outside_scope', time_entry_id: null },
      ] });
      const billId = await issue(draftId);
      const bill = (await sql<BillRow>`select id, number, reference, matter_reference, client_reference, client_name, supplier_name, net_pence, vat_pence, gross_pence, issued_at from issued_bills where id = ${billId}`.execute(db)).rows[0]!;
      expect(bill).toEqual({
        id: billId,
        number: expect.any(String),
        reference: expect.stringMatching(/^INV-\d{6,}$/),
        matter_reference: expect.stringMatching(/^C-\d{6,}\/\d{3,}$/),
        client_reference: expect.stringMatching(/^C-\d{6,}$/),
        client_name: expect.stringMatching(/^Jamie /),
        supplier_name: 'Stass Legal LLP',
        net_pence: '12500',
        vat_pence: '2000',
        gross_pence: '14500',
        issued_at: expect.any(Date),
      });
      expect((await sql<{ position: number; vat_pence: string; time_minutes: number | null; time_hourly_rate_pence: string | null }>`
        select position, vat_pence, time_minutes, time_hourly_rate_pence from issued_bill_lines where bill_id = ${billId} order by position
      `.execute(db)).rows).toEqual([
        { position: 1, vat_pence: '2000', time_minutes: 90, time_hourly_rate_pence: '24000' },
        { position: 2, vat_pence: '0', time_minutes: null, time_hourly_rate_pence: null },
      ]);

      const second = await issue(await createDraft({ lineValues: lines({ time_entry_id: null }) }));
      const references = (await sql<{ reference: string }>`select reference from issued_bills where id in (${billId}, ${second}) order by number`.execute(db)).rows.map((row) => row.reference);
      expect(BigInt(references[1]!.slice(4))).toBe(BigInt(references[0]!.slice(4)) + 1n);
    });

    it('allows an existing draft to issue after closure but requires the client billing address', async () => {
      const draftId = await createDraft();
      await db.insertInto('matter_closures').values({ matter_id: matterId, closed_by: partner.id, reason: 'All work is complete' }).execute();
      await expect(issue(draftId)).resolves.toEqual(expect.any(String));

      const noAddress = await openMatter(false);
      const noAddressTime = await addTime(noAddress.matterId);
      const missingAddressDraft = await createDraft({ targetMatter: noAddress.matterId, lineValues: lines({ time_entry_id: noAddressTime }) });
      await expect(issue(missingAddressDraft)).rejects.toThrow(/client address/i);
    });

    it('refuses reused or void time and serialises two attempts to issue one draft', async () => {
      const first = await issue(await createDraft());
      expect(first).toEqual(expect.any(String));
      await expect(issue(await createDraft())).rejects.toThrow(/already been billed/i);

      const freshTime = await addTime();
      const draftId = await createDraft({ lineValues: lines({ time_entry_id: freshTime }) });
      const outcomes = await Promise.allSettled([issue(draftId), issue(draftId)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    });

    it('serialises numbering when two different drafts issue together', async () => {
      const definition = (await sql<{ definition: string }>`select pg_get_functiondef('app.issue_bill(uuid,uuid)'::regprocedure) as definition`.execute(db)).rows[0]!.definition;
      expect(definition).toContain("pg_advisory_xact_lock(hashtextextended('app.issued_bill_number'");
      const firstDraft = await createDraft({ lineValues: lines({ time_entry_id: null }) });
      const secondDraft = await createDraft({ lineValues: lines({ time_entry_id: null, description: 'Second bill' }) });
      const outcomes = await Promise.all([issue(firstDraft), issue(secondDraft)]);
      const rows = (await sql<{ number: string }>`select number from issued_bills where id in (${outcomes[0]}, ${outcomes[1]}) order by number`.execute(db)).rows;
      expect(rows).toHaveLength(2);
      expect(BigInt(rows[1]!.number)).toBe(BigInt(rows[0]!.number) + 1n);
    });

    it('keeps issued headers and lines immutable with database-owned values', async () => {
      const billId = await issue(await createDraft());
      const lineId = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${billId}`.execute(db)).rows[0]!.id;
      await expect(sql`insert into issued_bills (draft_id, number, matter_id, client_id, matter_reference, client_reference, client_name, client_address_line1, client_town, client_country, supplier_name, supplier_address_line1, supplier_town, supplier_country, tax_point, due_on, net_pence, vat_pence, gross_pence, issued_by) values (${randomUUID()}, 1, ${matterId}, ${clientId}, 'chosen', 'chosen', 'chosen', 'chosen', 'chosen', 'GB', 'chosen', 'chosen', 'chosen', 'GB', ${today}::date, ${today}::date, 1, 0, 1, ${accounts.id})`.execute(db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update issued_bills set gross_pence = 1 where id = ${billId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`delete from issued_bill_lines where id = ${lineId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`truncate issued_bill_lines cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });

  describe('credit notes and delivery', () => {
    it('issues partial and final credits with the original VAT rate and remaining-penny rule', async () => {
      const billId = await issue(await createDraft({ lineValues: lines({ net_pence: '10003' }) }));
      const line = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${billId}`.execute(db)).rows[0]!;
      const firstId = await credit(billId, line.id, '5001');
      const secondId = await credit(billId, line.id, '5002');
      const credits = (await sql<{ reference: string; net_pence: string; vat_pence: string; gross_pence: string }>`
        select reference, net_pence, vat_pence, gross_pence from credit_notes where id in (${firstId}, ${secondId}) order by number
      `.execute(db)).rows;
      expect(credits).toEqual([
        { reference: expect.stringMatching(/^CRN-\d{6,}$/), net_pence: '5001', vat_pence: '1000', gross_pence: '6001' },
        { reference: expect.stringMatching(/^CRN-\d{6,}$/), net_pence: '5002', vat_pence: '1001', gross_pence: '6003' },
      ]);
    });

    it('refuses over-crediting, foreign or duplicate lines, bad reasons and non-Accounts actors', async () => {
      const billId = await issue(await createDraft());
      const lineId = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${billId}`.execute(db)).rows[0]!.id;
      await expect(credit(billId, lineId, '10001')).rejects.toThrow(/remaining amount/i);
      await expect(credit(billId, lineId, '100', '', accounts.id)).rejects.toThrow(/reason/i);
      await expect(credit(billId, lineId, '100', 'Not authorised', feeEarner.id)).rejects.toThrow(/active accounts/i);
      await expect(sql`select app.issue_credit_note(${billId}, 'Duplicate line', ${JSON.stringify([
        { bill_line_id: lineId, net_pence: '100' },
        { bill_line_id: lineId, net_pence: '100' },
      ])}::jsonb, ${accounts.id})`.execute(db)).rejects.toThrow(/duplicate/i);

      const otherTime = await addTime();
      const otherBill = await issue(await createDraft({ lineValues: lines({ time_entry_id: otherTime }) }));
      const otherLine = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${otherBill}`.execute(db)).rows[0]!.id;
      await expect(credit(billId, otherLine, '100')).rejects.toThrow(/does not belong/i);
    });

    it('serialises credits so two requests cannot exceed the remaining line amount', async () => {
      const billId = await issue(await createDraft());
      const lineId = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${billId}`.execute(db)).rows[0]!.id;
      const outcomes = await Promise.allSettled([
        credit(billId, lineId, '6000', 'First agreed reduction'),
        credit(billId, lineId, '6000', 'Second agreed reduction'),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    });

    it('records delivery for either fixed document and keeps credits and deliveries immutable', async () => {
      const billId = await issue(await createDraft());
      const lineId = (await sql<{ id: string }>`select id from issued_bill_lines where bill_id = ${billId}`.execute(db)).rows[0]!.id;
      const creditId = await credit(billId, lineId, '100');
      const billDelivery = (await sql<{ id: string }>`select app.record_bill_delivery(${billId}, null, 'email', 'Sent from the firm mailbox', ${accounts.id}) as id`.execute(db)).rows[0]!.id;
      const creditDelivery = (await sql<{ id: string }>`select app.record_bill_delivery(null, ${creditId}, 'post', null, ${accounts.id}) as id`.execute(db)).rows[0]!.id;
      expect((await sql<{ document_type: string; method: string }>`select document_type, method from bill_deliveries where id in (${billDelivery}, ${creditDelivery}) order by document_type`.execute(db)).rows).toEqual([
        { document_type: 'bill', method: 'email' },
        { document_type: 'credit_note', method: 'post' },
      ]);
      await expect(sql`select app.record_bill_delivery(${billId}, ${creditId}, 'email', null, ${accounts.id})`.execute(db)).rejects.toThrow(/exactly one/i);
      await expect(sql`select app.record_bill_delivery(${billId}, null, 'email', null, ${feeEarner.id})`.execute(db)).rejects.toThrow(/active accounts/i);
      await expect(sql`update credit_notes set reason = 'Changed' where id = ${creditId}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`delete from bill_deliveries where id = ${billDelivery}`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
      await expect(sql`truncate finance_postings, finance_transactions, bill_deliveries, credit_note_lines, credit_notes`.execute(ownerDb)).rejects.toThrow(/cannot be altered/i);
    });
  });
});
