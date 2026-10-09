import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { ParsedStatementRow } from './statement-csv.js';
import type { ClientAccountReconciliation, StatementImport, StatementMatch } from './reconciliation.js';

@Injectable()
export class ReconciliationRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async createImport(details: {
    bankAccountId: string; periodStart: string; periodEnd: string;
    openingBalancePence: string; closingBalancePence: string; fileName: string;
    hash: Buffer; rows: ParsedStatementRow[]; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const rows = details.rows.map((row) => ({
      occurred_on: row.occurredOn, amount_pence: row.amountPence,
      reference: row.reference, description: row.description, fingerprint: row.fingerprint,
    }));
    const result = await sql<{ id: string }>`select app.create_bank_statement_import(
      ${details.bankAccountId}, ${details.periodStart}::date, ${details.periodEnd}::date,
      ${details.openingBalancePence}::bigint, ${details.closingBalancePence}::bigint,
      ${details.fileName}, ${details.hash}, ${JSON.stringify(rows)}::jsonb, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async match(rowId: string, transactionId: string, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.match_bank_statement_row(
      ${rowId}, ${transactionId}, ${actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async reverse(matchId: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.reverse_bank_statement_match(
      ${matchId}, ${reason}, ${actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async prepare(details: {
    asOf: string; statementImportIds: string[]; explanations: Record<string, string>; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.prepare_client_account_reconciliation(
      ${details.asOf}::date, ${details.statementImportIds}::uuid[],
      ${JSON.stringify(details.explanations)}::jsonb, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async signOff(id: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.sign_off_client_account_reconciliation(${id}, ${actorId})`.execute(trx);
  }

  async findImport(id: string, executor: Kysely<Database> = this.db): Promise<StatementImport | undefined> {
    const statement = await executor.selectFrom('bank_statement_imports').select([
      'id', 'bank_account_id', 'period_start', 'period_end', 'opening_balance_pence',
      'closing_balance_pence', 'file_name', 'row_count', 'imported_by', 'imported_at',
    ]).where('id', '=', id).executeTakeFirst();
    if (!statement) return undefined;
    const rows = await executor.selectFrom('bank_statement_rows').select([
      'id', 'row_number', 'occurred_on', 'amount_pence', 'reference', 'description',
    ]).where('statement_import_id', '=', id).orderBy('row_number').execute();
    const events = await executor.selectFrom('bank_statement_match_events').select([
      'id', 'kind', 'statement_row_id', 'finance_transaction_id', 'reversed_match_id',
      'reason', 'acted_by', 'acted_at',
    ]).where('statement_row_id', 'in', rows.map((row) => row.id)).orderBy('id').execute();
    return {
      id: statement.id, bankAccountId: statement.bank_account_id,
      periodStart: statement.period_start, periodEnd: statement.period_end,
      openingBalancePence: statement.opening_balance_pence,
      closingBalancePence: statement.closing_balance_pence, fileName: statement.file_name,
      rowCount: statement.row_count, importedBy: statement.imported_by, importedAt: statement.imported_at,
      rows: rows.map((row) => ({
        id: row.id, rowNumber: row.row_number, occurredOn: row.occurred_on,
        amountPence: row.amount_pence, reference: row.reference, description: row.description,
        matches: matchHistory(row.id, events),
      })),
    };
  }

  async listImports(before?: string): Promise<StatementImport[]> {
    const rows = await this.db.selectFrom('bank_statement_imports').select('id')
      .$if(before !== undefined, (query) => query.where('id', '<', before as string))
      .orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findImport(row.id)))).filter((row): row is StatementImport => row !== undefined);
  }

  async findReconciliation(id: string, executor: Kysely<Database> = this.db): Promise<ClientAccountReconciliation | undefined> {
    const row = await executor.selectFrom('client_account_reconciliations').selectAll()
      .where('id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    const [statements, items, signOff] = await Promise.all([
      executor.selectFrom('client_account_reconciliation_statements').select('statement_import_id')
        .where('reconciliation_id', '=', id).orderBy('bank_account_id').execute(),
      executor.selectFrom('client_account_reconciliation_items').selectAll()
        .where('reconciliation_id', '=', id).orderBy('id').execute(),
      executor.selectFrom('client_account_reconciliation_sign_offs').selectAll()
        .where('reconciliation_id', '=', id).executeTakeFirst(),
    ]);
    return {
      id: row.id, asOf: row.as_of, bankBalancePence: row.bank_balance_pence,
      cashbookBalancePence: row.cashbook_balance_pence,
      clientLedgerBalancePence: row.client_ledger_balance_pence,
      bankCashbookDifferencePence: row.bank_cashbook_difference_pence,
      cashbookClientDifferencePence: row.cashbook_client_difference_pence,
      preparedBy: row.prepared_by, preparedAt: row.prepared_at,
      statementImportIds: statements.map((item) => item.statement_import_id),
      items: items.map((item) => ({
        id: item.id, kind: item.kind, sourceKey: item.source_key,
        bankAccountId: item.bank_account_id, occurredOn: item.occurred_on,
        amountPence: item.amount_pence, reference: item.reference, explanation: item.explanation,
      })),
      signOff: signOff ? { signedOffBy: signOff.signed_off_by, signedOffAt: signOff.signed_off_at } : null,
    };
  }

  async listReconciliations(before?: string): Promise<ClientAccountReconciliation[]> {
    const rows = await this.db.selectFrom('client_account_reconciliations').select('id')
      .$if(before !== undefined, (query) => query.where('id', '<', before as string))
      .orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findReconciliation(row.id))))
      .filter((row): row is ClientAccountReconciliation => row !== undefined);
  }

  async status(): Promise<{
    today: string;
    bankAccounts: { bankAccountId: string; kind: 'client' | 'business'; lastStatementEnd: string | null; dueOn: string; state: 'current' | 'warning' | 'overdue' }[];
    reconciliation: { lastSignedOffAsOf: string | null; dueOn: string | null; state: 'current' | 'warning' | 'overdue' | 'not_applicable' };
  }> {
    const accounts = await sql<{
      bank_account_id: string; kind: 'client' | 'business'; last_statement_end: string | null;
      due_on: string; state: 'current' | 'warning' | 'overdue';
    }>`with current_day as (select (clock_timestamp() at time zone 'Europe/London')::date as today)
      select b.id as bank_account_id, b.kind, max(i.period_end)::text as last_statement_end,
        (coalesce(max(i.period_end), b.opened_on) + 35)::text as due_on,
        case when (coalesce(max(i.period_end), b.opened_on) + 35) < d.today then 'overdue'
          when (coalesce(max(i.period_end), b.opened_on) + 35) <= d.today + 7 then 'warning'
          else 'current' end as state
      from app.bank_accounts b cross join current_day d
      left join app.bank_statement_imports i on i.bank_account_id = b.id
      where not exists (select 1 from app.bank_account_closures c
        where c.bank_account_id = b.id and c.closed_on < d.today)
      group by b.id, b.kind, b.opened_on, d.today order by b.kind, b.id`.execute(this.db);
    const reconciliation = (await sql<{
      today: string; last_signed_off_as_of: string | null; due_on: string | null;
      state: 'current' | 'warning' | 'overdue' | 'not_applicable';
    }>`with current_day as (select (clock_timestamp() at time zone 'Europe/London')::date as today),
      baseline as (
        select max(r.as_of) as last_date,
          (select min(b.opened_on) from app.bank_accounts b, current_day d where b.kind = 'client'
            and not exists (select 1 from app.bank_account_closures c
              where c.bank_account_id = b.id and c.closed_on < d.today)) as opened
        from app.client_account_reconciliations r
        join app.client_account_reconciliation_sign_offs s on s.reconciliation_id = r.id
      ) select d.today::text as today, b.last_date::text as last_signed_off_as_of,
        case when b.opened is null then null
          else (coalesce(b.last_date, b.opened) + 35)::text end as due_on,
        case when b.opened is null then 'not_applicable'
          when coalesce(b.last_date, b.opened) + 35 < d.today then 'overdue'
          when coalesce(b.last_date, b.opened) + 35 <= d.today + 7 then 'warning'
          else 'current' end as state
      from current_day d cross join baseline b`.execute(this.db)).rows[0]!;
    return {
      today: reconciliation.today,
      bankAccounts: accounts.rows.map((row) => ({
        bankAccountId: row.bank_account_id, kind: row.kind, lastStatementEnd: row.last_statement_end,
        dueOn: row.due_on, state: row.state,
      })),
      reconciliation: {
        lastSignedOffAsOf: reconciliation.last_signed_off_as_of,
        dueOn: reconciliation.due_on, state: reconciliation.state,
      },
    };
  }
}

function matchHistory(rowId: string, events: {
  id: string; kind: 'matched' | 'reversed'; statement_row_id: string;
  finance_transaction_id: string | null; reversed_match_id: string | null;
  reason: string | null; acted_by: string; acted_at: Date;
}[]): StatementMatch[] {
  const matches = events.filter((event) => event.statement_row_id === rowId && event.kind === 'matched');
  return matches.flatMap((match) => {
    if (!match.finance_transaction_id) return [];
    const reversal = events.find((event) => event.reversed_match_id === match.id);
    return [{
      id: match.id, financeTransactionId: match.finance_transaction_id,
      matchedBy: match.acted_by, matchedAt: match.acted_at,
      reversedBy: reversal?.acted_by ?? null, reversedAt: reversal?.acted_at ?? null,
      reversalReason: reversal?.reason ?? null,
    }];
  });
}
