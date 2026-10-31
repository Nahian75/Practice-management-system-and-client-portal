import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, FinancePostingAccount, FinanceTransactionKind, MatterStatus, TimeEntryCorrectionsTable } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import type { SealedBankDetails } from './bank-account-cipher.js';
import type { BankAccount, BillDraft, BillDraftSummary, BillLine, BillLineInput, CashBook, CreditNote, FinanceTransaction, IssuedBill, IssuedBillSummary, LedgerEntry, MatterLedger, MoneySide, RateAccount, StaffRate, SupplierSnapshot, TimeCorrection, TimeEntry } from './finance.js';

interface RateRow {
  id: string;
  account_id: string;
  account_name: string;
  hourly_rate_pence: string;
  effective_from: string;
  created_by: string;
  creator_name: string;
  created_at: Date;
}

interface TimeRow {
  id: string;
  matter_id: string;
  worker_id: string;
  worker_name: string;
  worked_on: string;
  minutes: number;
  description: string;
  hourly_rate_pence: string;
  voided: boolean;
  recorded_at: Date;
}

interface LedgerRow {
  id: string;
  transaction_id: string;
  kind: FinanceTransactionKind;
  account: FinancePostingAccount;
  direction: 'debit' | 'credit';
  amount_pence: string;
  matter_id: string;
  transaction_matter_id: string;
  related_matter_id: string | null;
  bank_account_id: string | null;
  related_bank_account_id: string | null;
  reference: string | null;
  purpose: string;
  occurred_on: string;
  posted_at: Date;
  running_balance: string;
}

type CorrectionRow = Selectable<TimeEntryCorrectionsTable> & { corrected_by_name: string };

@Injectable()
export class FinanceRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async createBillDraft(details: {
    matterId: string; taxPoint: string; dueOn: string; supplier: SupplierSnapshot;
    lines: BillLineInput[]; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_bill_draft(
      ${details.matterId}, ${details.taxPoint}::date, ${details.dueOn}::date,
      ${JSON.stringify(toSupplierJson(details.supplier))}::jsonb,
      ${JSON.stringify(details.lines.map(toLineJson))}::jsonb, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async replaceBillDraft(id: string, details: {
    taxPoint: string; dueOn: string; supplier: SupplierSnapshot; lines: BillLineInput[]; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    await sql`select app.replace_bill_draft(
      ${id}, ${details.taxPoint}::date, ${details.dueOn}::date,
      ${JSON.stringify(toSupplierJson(details.supplier))}::jsonb,
      ${JSON.stringify(details.lines.map(toLineJson))}::jsonb, ${details.actorId}
    )`.execute(trx);
  }

  async issueBill(draftId: string, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.issue_bill(${draftId}, ${actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async issueCreditNote(billId: string, reason: string, lines: { billLineId: string; netPence: string }[], actorId: string, trx: Kysely<Database>): Promise<string> {
    const values = lines.map((line) => ({ bill_line_id: line.billLineId, net_pence: line.netPence }));
    const result = await sql<{ id: string }>`select app.issue_credit_note(
      ${billId}, ${reason}, ${JSON.stringify(values)}::jsonb, ${actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async recordBillDelivery(target: { billId: string | null; creditNoteId: string | null; method: string; note: string | null; actorId: string }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_bill_delivery(
      ${target.billId}, ${target.creditNoteId}, ${target.method}, ${target.note}, ${target.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findBillDraft(id: string, executor: Kysely<Database> = this.db): Promise<BillDraft | undefined> {
    const row = await executor.selectFrom('bill_drafts')
      .selectAll().where('id', '=', id)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('issued_bills').select('id').whereRef('issued_bills.draft_id', '=', 'bill_drafts.id'))))
      .executeTakeFirst();
    if (!row) return undefined;
    const lines = await executor.selectFrom('bill_draft_lines').selectAll().where('draft_id', '=', id).orderBy('position').execute();
    const mapped = lines.map((line) => toDraftLine(line));
    const totals = sumLines(mapped);
    return {
      id: row.id, matterId: row.matter_id, status: 'draft', taxPoint: row.tax_point, dueOn: row.due_on,
      supplier: supplierFromRow(row), ...totals, lines: mapped, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async listBillDrafts(before?: string): Promise<BillDraftSummary[]> {
    const rows = await this.db.selectFrom('bill_drafts')
      .innerJoin('matters', 'matters.id', 'bill_drafts.matter_id')
      .innerJoin('clients', 'clients.id', 'matters.client_id')
      .leftJoin('client_individuals', 'client_individuals.client_id', 'clients.id')
      .leftJoin('client_organisations', 'client_organisations.client_id', 'clients.id')
      .select([
        'bill_drafts.id', 'bill_drafts.matter_id', 'matters.reference as matter_reference',
        'matters.title as matter_title', sql<string>`coalesce(client_organisations.legal_name, client_individuals.given_names || ' ' || client_individuals.family_name)`.as('client_name'), 'bill_drafts.tax_point',
        'bill_drafts.due_on', 'bill_drafts.updated_at',
      ])
      .where((eb) => eb.not(eb.exists(eb.selectFrom('issued_bills').select('id').whereRef('issued_bills.draft_id', '=', 'bill_drafts.id'))))
      .$if(before !== undefined, (query) => query.where('bill_drafts.id', '<', before as string))
      .orderBy('bill_drafts.id', 'desc').limit(100).execute();
    const totals = await Promise.all(rows.map((row) => this.findBillDraft(row.id)));
    return rows.map((row, index) => ({
      id: row.id, matterId: row.matter_id, matterReference: row.matter_reference, matterTitle: row.matter_title,
      clientName: row.client_name, taxPoint: row.tax_point, dueOn: row.due_on, grossPence: totals[index]!.grossPence,
      updatedAt: row.updated_at,
    }));
  }

  async findBill(id: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<IssuedBill | undefined> {
    const row = await executor.selectFrom('issued_bills').innerJoin('matters', 'matters.id', 'issued_bills.matter_id')
      .selectAll('issued_bills').where('issued_bills.id', '=', id)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId))).executeTakeFirst();
    return row && this.billFromRow(row, executor);
  }

  async listBills(matterId: string, viewerId: string, viewAll: boolean): Promise<IssuedBillSummary[] | undefined> {
    if (!(await this.matterAccess(matterId, viewerId, viewAll))) return undefined;
    const rows = await this.db.selectFrom('issued_bills').innerJoin('matters', 'matters.id', 'issued_bills.matter_id')
      .selectAll('issued_bills').where('issued_bills.matter_id', '=', matterId)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId))).orderBy('issued_bills.number', 'desc').execute();
    return rows.map((row) => ({
      id: row.id, reference: row.reference, matterId: row.matter_id, taxPoint: row.tax_point, dueOn: row.due_on,
      netPence: row.net_pence, vatPence: row.vat_pence, grossPence: row.gross_pence,
      issuedOn: row.issued_on, issuedAt: row.issued_at,
    }));
  }

  async findCreditNote(id: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<CreditNote | undefined> {
    const row = await executor.selectFrom('credit_notes')
      .innerJoin('issued_bills', 'issued_bills.id', 'credit_notes.bill_id')
      .innerJoin('matters', 'matters.id', 'issued_bills.matter_id')
      .selectAll('credit_notes').select(['issued_bills.reference as bill_reference', 'issued_bills.matter_id'])
      .where('credit_notes.id', '=', id)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId))).executeTakeFirst();
    if (!row) return undefined;
    const lines = await executor.selectFrom('credit_note_lines')
      .innerJoin('issued_bill_lines', 'issued_bill_lines.id', 'credit_note_lines.bill_line_id')
      .selectAll('credit_note_lines').select([
        'issued_bill_lines.description', 'issued_bill_lines.vat_treatment',
      ])
      .where('credit_note_id', '=', id).orderBy('credit_note_lines.position').execute();
    return {
      id: row.id, reference: row.reference, billId: row.bill_id, billReference: row.bill_reference,
      matterId: row.matter_id, reason: row.reason, netPence: row.net_pence, vatPence: row.vat_pence,
      grossPence: row.gross_pence, issuedAt: row.issued_at,
      issuedOn: row.issued_on,
      lines: lines.map((line) => ({
        id: line.id, position: line.position, billLineId: line.bill_line_id, description: line.description,
        vatTreatment: line.vat_treatment,
        netPence: line.net_pence, vatPence: line.vat_pence, grossPence: line.gross_pence,
      })),
    };
  }

  private async billFromRow(row: Selectable<Database['issued_bills']>, executor: Kysely<Database>): Promise<IssuedBill> {
    const lines = await executor.selectFrom('issued_bill_lines').selectAll().where('bill_id', '=', row.id).orderBy('position').execute();
    return {
      id: row.id, draftId: row.draft_id, reference: row.reference, matterId: row.matter_id,
      matterReference: row.matter_reference, clientReference: row.client_reference, clientName: row.client_name,
      clientAddress: {
        addressLine1: row.client_address_line1, addressLine2: row.client_address_line2, town: row.client_town,
        postcode: row.client_postcode, country: row.client_country,
      },
      supplier: supplierFromRow(row), taxPoint: row.tax_point, dueOn: row.due_on,
      netPence: row.net_pence, vatPence: row.vat_pence, grossPence: row.gross_pence,
      issuedOn: row.issued_on, issuedAt: row.issued_at,
      lines: lines.map((line) => ({
        id: line.id, position: line.position, kind: line.kind, description: line.description,
        netPence: line.net_pence, vatTreatment: line.vat_treatment, timeEntryId: line.source_time_entry_id, expenseEntryId: line.source_expense_entry_id,
        vatPence: line.vat_pence, grossPence: line.gross_pence,
        ...(line.time_worker_name === null ? {} : { time: {
          workerName: line.time_worker_name, workedOn: line.time_worked_on!, minutes: line.time_minutes!,
          hourlyRatePence: line.time_hourly_rate_pence!,
        } }),
      })),
    };
  }

  async createBankAccount(details: {
    kind: 'client' | 'business'; name: string; openedOn: string; actorId: string; sealed: SealedBankDetails;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_bank_account(
      ${details.kind}, ${details.name}, ${details.sealed.lastFour}, ${details.sealed.context}::uuid,
      ${details.sealed.fingerprint}, ${details.sealed.keyVersion}::smallint, ${details.sealed.nonce},
      ${details.sealed.ciphertext}, ${details.sealed.authTag}, ${details.openedOn}::date, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async closeBankAccount(id: string, closedOn: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.close_bank_account(
      ${id}, ${closedOn}::date, ${reason}, ${actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findBankAccount(id: string, executor: Kysely<Database> = this.db): Promise<BankAccount | undefined> {
    const row = await executor.selectFrom('bank_accounts')
      .leftJoin('bank_account_closures', 'bank_account_closures.bank_account_id', 'bank_accounts.id')
      .select([
        'bank_accounts.id', 'bank_accounts.kind', 'bank_accounts.name', 'bank_accounts.last_four',
        'bank_accounts.opened_on', 'bank_accounts.created_at', 'bank_account_closures.closed_on',
      ]).where('bank_accounts.id', '=', id).executeTakeFirst();
    return row && toBankAccount(row);
  }

  async listBankAccounts(): Promise<BankAccount[]> {
    const rows = await this.db.selectFrom('bank_accounts')
      .leftJoin('bank_account_closures', 'bank_account_closures.bank_account_id', 'bank_accounts.id')
      .select([
        'bank_accounts.id', 'bank_accounts.kind', 'bank_accounts.name', 'bank_accounts.last_four',
        'bank_accounts.opened_on', 'bank_accounts.created_at', 'bank_account_closures.closed_on',
      ]).orderBy('bank_accounts.id').execute();
    return rows.map(toBankAccount);
  }

  async recordReceipt(details: {
    bankAccountId: string; matterId: string; receivedOn: string; amountPence: string;
    reference: string; purpose: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_finance_receipt(
      ${details.bankAccountId}, ${details.matterId}, ${details.receivedOn}::date,
      ${details.amountPence}::bigint, ${details.reference}, ${details.purpose}, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async recordAllocation(details: {
    side: MoneySide; sourceMatterId: string; targetMatterId: string;
    amountPence: string; reason: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_finance_allocation(
      ${details.side}, ${details.sourceMatterId}, ${details.targetMatterId},
      ${details.amountPence}::bigint, ${details.reason}, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findFinanceTransaction(id: string, executor: Kysely<Database> = this.db): Promise<FinanceTransaction | undefined> {
    const row = await executor.selectFrom('finance_transactions').selectAll().where('id', '=', id).executeTakeFirst();
    return row && {
      id: row.id, kind: row.kind, side: transactionSide(row.kind), clientId: row.client_id,
      matterId: row.matter_id, relatedMatterId: row.related_matter_id, bankAccountId: row.bank_account_id,
      relatedBankAccountId: row.related_bank_account_id, sourcePaymentRequestId: row.source_payment_request_id,
      reference: row.reference, purpose: row.purpose, amountPence: row.amount_pence,
      occurredOn: row.occurred_on, postedAt: row.posted_at,
    };
  }

  async matterLedger(matterId: string, page: { before?: string; limit?: number }): Promise<MatterLedger | undefined> {
    if (!(await this.db.selectFrom('matters').select('id').where('id', '=', matterId).executeTakeFirst())) return undefined;
    const totals = (await sql<{ client_balance: string; business_balance: string }>`
      select
        coalesce(sum(case when account = 'client_ledger' then
          case direction when 'credit' then amount_pence else -amount_pence end else 0 end), 0) as client_balance,
        coalesce(sum(case when account = 'business_ledger' then
          case direction when 'debit' then amount_pence else -amount_pence end else 0 end), 0) as business_balance
      from finance_postings where matter_id = ${matterId}
    `.execute(this.db)).rows[0]!;
    const rows = await this.ledgerRows('matter')
      .where('finance_postings.matter_id', '=', matterId)
      .where('finance_postings.account', 'in', ['client_ledger', 'business_ledger'])
      .$if(page.before !== undefined, (query) => query.where('finance_postings.id', '<', page.before as string))
      .orderBy('finance_postings.id', 'desc')
      .$if(page.limit !== undefined, (query) => query.limit(page.limit as number)).execute();
    return {
      matterId, clientBalancePence: totals.client_balance, businessBalancePence: totals.business_balance,
      entries: rows.map(toLedgerEntry),
    };
  }

  async cashBook(bankAccountId: string, page: { before?: string; limit?: number }): Promise<CashBook | undefined> {
    const bankAccount = await this.findBankAccount(bankAccountId);
    if (!bankAccount) return undefined;
    const total = (await sql<{ balance: string }>`
      select coalesce(sum(case direction when 'debit' then amount_pence else -amount_pence end), 0) as balance
      from finance_postings where bank_account_id = ${bankAccountId}
    `.execute(this.db)).rows[0]!.balance;
    const rows = await this.ledgerRows('bank')
      .where('finance_postings.bank_account_id', '=', bankAccountId)
      .$if(page.before !== undefined, (query) => query.where('finance_postings.id', '<', page.before as string))
      .orderBy('finance_postings.id', 'desc')
      .$if(page.limit !== undefined, (query) => query.limit(page.limit as number)).execute();
    return { bankAccount, balancePence: total, entries: rows.map(toLedgerEntry) };
  }

  async eligibleRateAccount(accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', accountId)
      .where('kind', '=', 'staff')
      .where('status', '=', 'active')
      .where((eb) => eb.exists(
        eb.selectFrom('account_roles').select('id')
          .whereRef('account_roles.account_id', '=', 'accounts.id')
          .where('role', 'in', ['partner', 'fee_earner'])
          .where('revoked_at', 'is', null),
      ))
      .executeTakeFirst();
    return row !== undefined;
  }

  async rateAccounts(): Promise<RateAccount[]> {
    const rows = await this.db.selectFrom('accounts')
      .innerJoin('account_roles', 'account_roles.account_id', 'accounts.id')
      .select(['accounts.id', 'accounts.display_name', 'account_roles.role'])
      .where('accounts.kind', '=', 'staff').where('accounts.status', '=', 'active')
      .where('account_roles.revoked_at', 'is', null).where('account_roles.role', 'in', ['partner', 'fee_earner'])
      .orderBy('accounts.display_name').orderBy('accounts.id').execute();
    const grouped = new Map<string, RateAccount>();
    for (const row of rows) {
      const account = grouped.get(row.id) ?? { accountId: row.id, displayName: row.display_name, roles: [] };
      account.roles.push(row.role as 'partner' | 'fee_earner'); grouped.set(row.id, account);
    }
    return [...grouped.values()];
  }

  async insertRate(rate: { accountId: string; hourlyRatePence: string; effectiveFrom: string; createdBy: string }, trx: Kysely<Database>): Promise<string> {
    return (await trx.insertInto('staff_rates').values({
      account_id: rate.accountId,
      hourly_rate_pence: rate.hourlyRatePence,
      effective_from: rate.effectiveFrom,
      created_by: rate.createdBy,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async findRate(id: string, executor: Kysely<Database> = this.db): Promise<StaffRate | undefined> {
    const row = await this.rateRows(executor).where('staff_rates.id', '=', id).executeTakeFirst();
    return row && toRate(row);
  }

  async listRates(page: { accountId?: string; before?: string; limit: number }): Promise<StaffRate[]> {
    const rows = await this.rateRows(this.db)
      .$if(page.accountId !== undefined, (query) => query.where('staff_rates.account_id', '=', page.accountId as string))
      .$if(page.before !== undefined, (query) => query.where('staff_rates.id', '<', page.before as string))
      .orderBy('staff_rates.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map(toRate);
  }

  matterAccess(matterId: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<{ status: MatterStatus } | undefined> {
    let query = executor.selectFrom('matters').select('status').where('id', '=', matterId);
    if (!viewAll) {
      query = query.where(visibleTo(viewerId));
    }
    return query.executeTakeFirst();
  }

  async effectiveRate(accountId: string, workedOn: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    return (await executor.selectFrom('staff_rates').select('id')
      .where('account_id', '=', accountId)
      .where('effective_from', '<=', workedOn)
      .orderBy('effective_from', 'desc')
      .executeTakeFirst()) !== undefined;
  }

  async insertTime(entry: { matterId: string; workerId: string; workedOn: string; minutes: number; description: string }, trx: Kysely<Database>): Promise<string> {
    return (await trx.insertInto('time_entries').values({
      matter_id: entry.matterId,
      worker_id: entry.workerId,
      worked_on: entry.workedOn,
      minutes: entry.minutes,
      description: entry.description,
      recorded_by: entry.workerId,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async listTime(matterId: string, viewerId: string, viewAll: boolean, page: { before?: string; limit: number }): Promise<TimeEntry[] | undefined> {
    if (!(await this.matterAccess(matterId, viewerId, viewAll))) {
      return undefined;
    }
    const rows = await this.timeRows(this.db)
      .where('time_entries.matter_id', '=', matterId)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId)))
      .$if(page.before !== undefined, (query) => query.where('time_entries.id', '<', page.before as string))
      .orderBy('time_entries.id', 'desc')
      .limit(page.limit)
      .execute();
    return this.withCorrections(rows);
  }

  async findTime(id: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<TimeEntry | undefined> {
    const row = await this.timeRows(executor)
      .where('time_entries.id', '=', id)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId)))
      .executeTakeFirst();
    return row && (await this.withCorrections([row], executor))[0];
  }

  async findOwnedForCorrection(id: string, workerId: string, executor: Kysely<Database>): Promise<TimeEntry | undefined> {
    const row = await this.timeRows(executor)
      .where('time_entries.id', '=', id)
      .where('time_entries.worker_id', '=', workerId)
      .where(visibleTo(workerId))
      .executeTakeFirst();
    return row && (await this.withCorrections([row], executor))[0];
  }

  async insertCorrection(correction: {
    timeEntryId: string;
    replacement: { workedOn: string; minutes: number; description: string } | null;
    reason: string;
    correctedBy: string;
  }, trx: Kysely<Database>) {
    return trx.insertInto('time_entry_corrections').values({
      time_entry_id: correction.timeEntryId,
      to_worked_on: correction.replacement?.workedOn ?? null,
      to_minutes: correction.replacement?.minutes ?? null,
      to_description: correction.replacement?.description ?? null,
      reason: correction.reason,
      corrected_by: correction.correctedBy,
    }).returning(['id', 'from_worked_on', 'to_worked_on', 'from_minutes', 'to_minutes', 'from_description', 'to_description', 'from_hourly_rate_pence', 'to_hourly_rate_pence']).executeTakeFirst();
  }

  private rateRows(executor: Kysely<Database>) {
    return executor.selectFrom('staff_rates')
      .innerJoin('accounts as rate_account', 'rate_account.id', 'staff_rates.account_id')
      .innerJoin('accounts as rate_creator', 'rate_creator.id', 'staff_rates.created_by')
      .select([
        'staff_rates.id', 'staff_rates.account_id', 'rate_account.display_name as account_name',
        'staff_rates.hourly_rate_pence', 'staff_rates.effective_from', 'staff_rates.created_by',
        'rate_creator.display_name as creator_name', 'staff_rates.created_at',
      ]);
  }

  private timeRows(executor: Kysely<Database>) {
    return executor.selectFrom('time_entries')
      .innerJoin('matters', 'matters.id', 'time_entries.matter_id')
      .innerJoin('accounts as time_worker', 'time_worker.id', 'time_entries.worker_id')
      .select([
        'time_entries.id', 'time_entries.matter_id', 'time_entries.worker_id',
        'time_worker.display_name as worker_name', 'time_entries.worked_on',
        'time_entries.minutes', 'time_entries.description', 'time_entries.hourly_rate_pence',
        'time_entries.voided', 'time_entries.recorded_at',
      ]);
  }

  private ledgerRows(scope: 'matter' | 'bank') {
    const runningBalance = scope === 'bank'
      ? sql<string>`(
          select coalesce(sum(case p2.direction when 'debit' then p2.amount_pence else -p2.amount_pence end), 0)
          from app.finance_postings p2
          where p2.bank_account_id = finance_postings.bank_account_id
            and p2.id <= finance_postings.id
        )`
      : sql<string>`(
          select coalesce(sum(case
            when p2.account = 'client_ledger' then
              case p2.direction when 'credit' then p2.amount_pence else -p2.amount_pence end
            else case p2.direction when 'debit' then p2.amount_pence else -p2.amount_pence end
          end), 0)
          from app.finance_postings p2
          where p2.matter_id = finance_postings.matter_id
            and p2.account = finance_postings.account
            and p2.id <= finance_postings.id
        )`;
    return this.db.selectFrom('finance_postings')
      .innerJoin('finance_transactions', 'finance_transactions.id', 'finance_postings.transaction_id')
      .select([
        'finance_postings.id', 'finance_postings.transaction_id', 'finance_postings.account',
        'finance_postings.direction', 'finance_postings.amount_pence', 'finance_postings.matter_id',
        'finance_postings.bank_account_id', 'finance_transactions.kind',
        'finance_transactions.matter_id as transaction_matter_id', 'finance_transactions.related_matter_id',
        'finance_transactions.related_bank_account_id',
        'finance_transactions.reference', 'finance_transactions.purpose', 'finance_transactions.occurred_on',
        'finance_transactions.posted_at', runningBalance.as('running_balance'),
      ]);
  }

  private async withCorrections(rows: TimeRow[], executor: Kysely<Database> = this.db): Promise<TimeEntry[]> {
    if (rows.length === 0) {
      return [];
    }
    const corrections = await executor.selectFrom('time_entry_corrections')
      .innerJoin('accounts as correcting_account', 'correcting_account.id', 'time_entry_corrections.corrected_by')
      .selectAll('time_entry_corrections')
      .select('correcting_account.display_name as corrected_by_name')
      .where('time_entry_id', 'in', rows.map((row) => row.id))
      .orderBy('time_entry_corrections.id')
      .execute();
    return rows.map((row) => toTime(row, corrections.filter((correction) => correction.time_entry_id === row.id)));
  }
}

function toSupplierJson(supplier: SupplierSnapshot) {
  return {
    name: supplier.name, address_line1: supplier.addressLine1, address_line2: supplier.addressLine2,
    town: supplier.town, postcode: supplier.postcode, country: supplier.country,
    vat_registration_number: supplier.vatRegistrationNumber,
  };
}

function toLineJson(line: BillLineInput) {
  return {
    kind: line.kind, description: line.description, net_pence: line.netPence,
    vat_treatment: line.vatTreatment, time_entry_id: line.timeEntryId,
    expense_entry_id: line.expenseEntryId ?? null,
  };
}

function vatFor(netPence: string, treatment: BillLine['vatTreatment']): string {
  const rate = treatment === 'standard' ? 20n : treatment === 'reduced' ? 5n : 0n;
  return ((BigInt(netPence) * rate + 50n) / 100n).toString();
}

function toDraftLine(row: Selectable<Database['bill_draft_lines']>): BillLine {
  const vatPence = vatFor(row.net_pence, row.vat_treatment);
  return {
    id: row.id, position: row.position, kind: row.kind, description: row.description,
    netPence: row.net_pence, vatTreatment: row.vat_treatment, timeEntryId: row.time_entry_id, expenseEntryId: row.expense_entry_id,
    vatPence, grossPence: (BigInt(row.net_pence) + BigInt(vatPence)).toString(),
  };
}

function sumLines(lines: BillLine[]) {
  const net = lines.reduce((sum, line) => sum + BigInt(line.netPence), 0n);
  const vat = lines.reduce((sum, line) => sum + BigInt(line.vatPence), 0n);
  return { netPence: net.toString(), vatPence: vat.toString(), grossPence: (net + vat).toString() };
}

function supplierFromRow(row: {
  supplier_name: string; supplier_address_line1: string; supplier_address_line2: string | null;
  supplier_town: string; supplier_postcode: string | null; supplier_country: string;
  supplier_vat_registration_number: string | null;
}): SupplierSnapshot {
  return {
    name: row.supplier_name, addressLine1: row.supplier_address_line1, addressLine2: row.supplier_address_line2,
    town: row.supplier_town, postcode: row.supplier_postcode, country: row.supplier_country,
    vatRegistrationNumber: row.supplier_vat_registration_number,
  };
}

function toRate(row: RateRow): StaffRate {
  return {
    id: row.id,
    account: { accountId: row.account_id, displayName: row.account_name },
    hourlyRatePence: row.hourly_rate_pence,
    effectiveFrom: row.effective_from,
    createdBy: { accountId: row.created_by, displayName: row.creator_name },
    createdAt: row.created_at,
  };
}

function toTime(row: TimeRow, corrections: CorrectionRow[]): TimeEntry {
  return {
    id: row.id,
    matterId: row.matter_id,
    worker: { accountId: row.worker_id, displayName: row.worker_name },
    workedOn: row.worked_on,
    minutes: row.minutes,
    description: row.description,
    hourlyRatePence: row.hourly_rate_pence,
    voided: row.voided,
    recordedAt: row.recorded_at,
    corrections: corrections.map((correction): TimeCorrection => ({
      id: correction.id,
      from: {
        workedOn: correction.from_worked_on,
        minutes: correction.from_minutes,
        description: correction.from_description,
        hourlyRatePence: correction.from_hourly_rate_pence,
      },
      to: correction.to_worked_on === null ? null : {
        workedOn: correction.to_worked_on,
        minutes: correction.to_minutes!,
        description: correction.to_description!,
        hourlyRatePence: correction.to_hourly_rate_pence!,
      },
      reason: correction.reason,
      correctedBy: { accountId: correction.corrected_by, displayName: correction.corrected_by_name },
      correctedAt: correction.corrected_at,
    })),
  };
}

function toBankAccount(row: {
  id: string; kind: 'client' | 'business'; name: string; last_four: string;
  opened_on: string; created_at: Date; closed_on: string | null;
}): BankAccount {
  return {
    id: row.id, kind: row.kind, name: row.name, lastFour: row.last_four,
    openedOn: row.opened_on, closedOn: row.closed_on, createdAt: row.created_at,
  };
}

function transactionSide(kind: FinanceTransactionKind): MoneySide {
  return kind.startsWith('client_') || kind === 'costs_transfer' ? 'client' : 'business';
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  const relatedMatterId = row.related_matter_id === null
    ? null
    : row.matter_id === row.transaction_matter_id ? row.related_matter_id : row.transaction_matter_id;
  return {
    id: row.id, transactionId: row.transaction_id, kind: row.kind,
    side: row.account.startsWith('client_') ? 'client' : 'business',
    direction: row.direction, amountPence: row.amount_pence, matterId: row.matter_id,
    runningBalancePence: row.running_balance,
    relatedMatterId, bankAccountId: row.bank_account_id, relatedBankAccountId: row.related_bank_account_id,
    reference: row.reference, purpose: row.purpose, occurredOn: row.occurred_on, postedAt: row.posted_at,
  };
}
