export interface StatementRow {
  id: string;
  rowNumber: number;
  occurredOn: string;
  amountPence: string;
  reference: string;
  description: string;
  matches: StatementMatch[];
}

export interface StatementMatch {
  id: string;
  financeTransactionId: string;
  matchedBy: string;
  matchedAt: Date;
  reversedBy: string | null;
  reversedAt: Date | null;
  reversalReason: string | null;
}

export interface StatementImport {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  openingBalancePence: string;
  closingBalancePence: string;
  fileName: string;
  rowCount: number;
  importedBy: string;
  importedAt: Date;
  rows: StatementRow[];
}

export interface ReconciliationItem {
  id: string;
  kind: 'unmatched_statement' | 'unmatched_cashbook' | 'difference';
  sourceKey: string;
  bankAccountId: string | null;
  occurredOn: string | null;
  amountPence: string;
  reference: string | null;
  explanation: string;
}

export interface ClientAccountReconciliation {
  id: string;
  asOf: string;
  bankBalancePence: string;
  cashbookBalancePence: string;
  clientLedgerBalancePence: string;
  bankCashbookDifferencePence: string;
  cashbookClientDifferencePence: string;
  preparedBy: string;
  preparedAt: Date;
  statementImportIds: string[];
  items: ReconciliationItem[];
  signOff: { signedOffBy: string; signedOffAt: Date } | null;
}
