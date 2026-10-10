import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { FinanceActor } from './finance.service.js';
import type { ClientAccountReconciliation, StatementImport } from './reconciliation.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import type { ParsedStatementCsv } from './statement-csv.js';
import { financeCsv } from './finance-export.js';
import { signedPenceToPounds } from './money.js';

export type ReconciliationChange<T> =
  | { outcome: 'changed'; value: T }
  | { outcome: 'not_found' | 'conflict' };

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly reconciliations: ReconciliationRepository,
    private readonly audit: AuditService,
  ) {}

  async importStatement(details: {
    bankAccountId: string; periodStart: string; periodEnd: string;
    openingBalancePence: string; closingBalancePence: string; fileName: string;
    csv: ParsedStatementCsv;
  }, by: FinanceActor): Promise<ReconciliationChange<StatementImport>> {
    try {
      const value = await this.reconciliations.transaction(async (trx) => {
        const id = await this.reconciliations.createImport({
          ...details, hash: details.csv.hash, rows: details.csv.rows, actorId: by.accountId,
        }, trx);
        const statement = await this.reconciliations.findImport(id, trx);
        if (!statement) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'finance.bank_statement_imported', outcome: 'success',
          resource: { type: 'bank_statement_import', id },
          metadata: { bankAccountId: details.bankAccountId, periodEnd: details.periodEnd, rowCount: details.csv.rows.length },
          ...by.context,
        }, trx);
        return statement;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) {
      return databaseOutcome(error);
    }
  }

  findImport(id: string): Promise<StatementImport | undefined> {
    return this.reconciliations.findImport(id);
  }

  listImports(before?: string): Promise<StatementImport[]> {
    return this.reconciliations.listImports(before);
  }

  async match(rowId: string, transactionId: string, by: FinanceActor): Promise<ReconciliationChange<{ id: string }>> {
    try {
      const value = await this.reconciliations.transaction(async (trx) => {
        const id = await this.reconciliations.match(rowId, transactionId, by.accountId, trx);
        await this.audit.record({
          actor: by.actor, action: 'finance.bank_transaction_matched', outcome: 'success',
          resource: { type: 'bank_statement_match', id }, metadata: { statementRowId: rowId, financeTransactionId: transactionId },
          ...by.context,
        }, trx);
        return { id };
      });
      return { outcome: 'changed', value };
    } catch (error) {
      const result = databaseOutcome<{ id: string }>(error);
      if (result.outcome === 'conflict') await this.denied('finance.bank_transaction_matched', 'bank_statement_row', rowId, by);
      return result;
    }
  }

  async reverse(matchId: string, reason: string, by: FinanceActor): Promise<ReconciliationChange<{ id: string }>> {
    try {
      const value = await this.reconciliations.transaction(async (trx) => {
        const id = await this.reconciliations.reverse(matchId, reason, by.accountId, trx);
        await this.audit.record({
          actor: by.actor, action: 'finance.bank_transaction_match_reversed', outcome: 'success',
          resource: { type: 'bank_statement_match_reversal', id }, metadata: { reversedMatchId: matchId },
          ...by.context,
        }, trx);
        return { id };
      });
      return { outcome: 'changed', value };
    } catch (error) {
      const result = databaseOutcome<{ id: string }>(error);
      if (result.outcome === 'conflict') await this.denied('finance.bank_transaction_match_reversed', 'bank_statement_match', matchId, by);
      return result;
    }
  }

  async prepare(details: {
    asOf: string; statementImportIds: string[]; explanations: Record<string, string>;
  }, by: FinanceActor): Promise<ReconciliationChange<ClientAccountReconciliation>> {
    try {
      const value = await this.reconciliations.transaction(async (trx) => {
        const id = await this.reconciliations.prepare({ ...details, actorId: by.accountId }, trx);
        const reconciliation = await this.reconciliations.findReconciliation(id, trx);
        if (!reconciliation) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'finance.reconciliation_prepared', outcome: 'success',
          resource: { type: 'client_account_reconciliation', id },
          metadata: { asOf: details.asOf, statementCount: details.statementImportIds.length, itemCount: reconciliation.items.length },
          ...by.context,
        }, trx);
        return reconciliation;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) {
      return databaseOutcome(error);
    }
  }

  findReconciliation(id: string): Promise<ClientAccountReconciliation | undefined> {
    return this.reconciliations.findReconciliation(id);
  }

  async exportReconciliation(id: string, by: FinanceActor): Promise<{ fileName: string; content: Buffer } | undefined> {
    const reconciliation = await this.reconciliations.findReconciliation(id);
    if (!reconciliation) return undefined;
    await this.audit.record({
      actor: by.actor, action: 'finance.reconciliation_exported', outcome: 'success',
      resource: { type: 'client_account_reconciliation', id },
      metadata: { asOf: reconciliation.asOf, itemCount: reconciliation.items.length, signedOff: reconciliation.signOff !== null },
      ...by.context,
    });
    return {
      fileName: `client-account-reconciliation-${reconciliation.asOf}.csv`,
      content: financeCsv([
        ['Client account reconciliation', reconciliation.asOf],
        ['Bank balance GBP', signedPenceToPounds(reconciliation.bankBalancePence)],
        ['Cash book balance GBP', signedPenceToPounds(reconciliation.cashbookBalancePence)],
        ['Client ledger balance GBP', signedPenceToPounds(reconciliation.clientLedgerBalancePence)],
        ['Bank / cash book difference GBP', signedPenceToPounds(reconciliation.bankCashbookDifferencePence)],
        ['Cash book / client ledger difference GBP', signedPenceToPounds(reconciliation.cashbookClientDifferencePence)],
        ['Prepared at', reconciliation.preparedAt.toISOString()],
        ['Signed off at', reconciliation.signOff?.signedOffAt.toISOString() ?? 'Not signed off'],
        [],
        ['Client liability balances'],
        ['Client id', 'Matter id', 'Balance GBP'],
        ...reconciliation.clientBalances.map((balance) => [
          balance.clientId, balance.matterId, signedPenceToPounds(balance.balancePence),
        ]),
        [],
        ['Item type', 'Date', 'Amount GBP', 'Reference', 'Explanation'],
        ...reconciliation.items.map((item) => [
          item.kind, item.occurredOn, signedPenceToPounds(item.amountPence), item.reference, item.explanation,
        ]),
      ]),
    };
  }

  listReconciliations(before?: string): Promise<ClientAccountReconciliation[]> {
    return this.reconciliations.listReconciliations(before);
  }

  async signOff(id: string, by: FinanceActor): Promise<ReconciliationChange<ClientAccountReconciliation>> {
    try {
      const value = await this.reconciliations.transaction(async (trx) => {
        await this.reconciliations.signOff(id, by.accountId, trx);
        const reconciliation = await this.reconciliations.findReconciliation(id, trx);
        if (!reconciliation) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'finance.reconciliation_signed_off', outcome: 'success',
          resource: { type: 'client_account_reconciliation', id }, metadata: { asOf: reconciliation.asOf },
          ...by.context,
        }, trx);
        return reconciliation;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) {
      const result = databaseOutcome<ClientAccountReconciliation>(error);
      if (result.outcome === 'conflict') await this.denied('finance.reconciliation_signed_off', 'client_account_reconciliation', id, by);
      return result;
    }
  }

  status() { return this.reconciliations.status(); }

  private denied(action: string, resourceType: string, id: string, by: FinanceActor) {
    return this.audit.record({
      actor: by.actor, action, outcome: 'denied', resource: { type: resourceType, id }, ...by.context,
    });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function databaseOutcome<T>(error: unknown): ReconciliationChange<T> {
  if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
  if (['23505', '23514', '42501', '22P02', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
  throw error;
}
