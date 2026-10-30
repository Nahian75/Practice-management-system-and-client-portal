import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import {
  PAYMENT_KIND_LABELS, PAYMENT_STATUS_LABELS, pounds, type BankAccount, type BillDraftSummary,
  type FinanceAccess, type PaymentRequest, type RateAccount, type Reconciliation, type ReconciliationStatus,
  type StaffRate, type StatementImport,
} from '@/lib/finance';
import { FinanceForms } from './finance-forms';
import {WorkspaceHeading} from '@/components/workspace-page';

export const metadata: Metadata = { title: 'Finance' };

export default async function FinancePage() {
  const access = await apiGet<FinanceAccess>('/finance/access');
  if (access.status === 403 || !access.body) return <NoAccess what="firm-wide finance" />;
  const [banks, payments, statements, reconciliations, status, drafts, rates, rateAccounts] = await Promise.all([
    apiGet<{ bankAccounts: BankAccount[] }>('/finance/bank-accounts'),
    apiGet<{ paymentRequests: PaymentRequest[]; next: string | null }>('/finance/payment-requests'),
    apiGet<{ statements: StatementImport[]; next: string | null }>('/finance/statement-imports'),
    apiGet<{ reconciliations: Reconciliation[]; next: string | null }>('/finance/reconciliations'),
    apiGet<ReconciliationStatus>('/finance/reconciliations/status'),
    access.body.canManageBilling
      ? apiGet<{ drafts: BillDraftSummary[]; next: string | null }>('/finance/bill-drafts')
      : Promise.resolve({ status: 403, body: undefined }),
    apiGet<{ rates: StaffRate[]; next: string | null }>('/finance/rates'),
    access.body.canManageBilling
      ? apiGet<{ accounts: RateAccount[] }>('/finance/rate-accounts')
      : Promise.resolve({ status: 403, body: undefined }),
  ]);
  if (!banks.body || !payments.body || !statements.body || !reconciliations.body || !status.body) {
    throw new Error('Could not load finance workspace');
  }
  const bankNames = new Map(banks.body.bankAccounts.map((bank) => [bank.id, `${bank.name} •••• ${bank.lastFour}`]));
  return <>
    <WorkspaceHeading title="Billing & accounts" description="Review billing, payment requests and bank records in one workspace."/>
    <nav className="workspace-tabs" aria-label="Finance sections"><Link href="#drafts-heading">Draft bills</Link><Link href="#payments-heading">Payment requests</Link><Link href="#rates-heading">Rates</Link><Link href="#statements-heading">Statements</Link><Link href="#reconciliations-heading">Reconciliations</Link></nav>
    <p className="secondary">GBP records only. Stass records authority and bank-confirmed outcomes; it does not move money.</p>
    <section aria-labelledby="deadlines-heading">
      <h2 id="deadlines-heading">Deadlines</h2>
      <div className={`notice notice-${status.body.reconciliation.state}`}>
        <p><strong>Client-account reconciliation: {stateLabel(status.body.reconciliation.state)}.</strong>{' '}
          {status.body.reconciliation.dueOn ? `Due ${formatCalendarDate(status.body.reconciliation.dueOn)}.` : 'No open client bank account.'}</p>
      </div>
      <table className="table"><caption className="secondary">Statement freshness for every open bank account.</caption>
        <thead><tr><th scope="col">Account</th><th scope="col">Last statement</th><th scope="col">Next due</th><th scope="col">State</th></tr></thead>
        <tbody>{status.body.bankAccounts.map((item) => <tr key={item.bankAccountId}><td><Link href={`/finance/bank-accounts/${item.bankAccountId}`}>{bankNames.get(item.bankAccountId) ?? item.bankAccountId}</Link></td>
          <td>{item.lastStatementEnd ? formatCalendarDate(item.lastStatementEnd) : 'None'}</td><td>{formatCalendarDate(item.dueOn)}</td><td>{stateLabel(item.state)}</td></tr>)}</tbody>
      </table>
    </section>

    {access.body.canManageBilling && <section aria-labelledby="drafts-heading"><h2 id="drafts-heading">Draft bills</h2>
      {!drafts.body?.drafts.length ? <p>No draft bills.</p> : <table className="table"><thead><tr><th scope="col">Matter</th><th scope="col">Client</th><th scope="col">Due</th><th scope="col">Total</th><th scope="col">Updated</th></tr></thead>
        <tbody>{drafts.body.drafts.map((draft) => <tr key={draft.id}><td><Link href={`/finance/bill-drafts/${draft.id}`}>{draft.matterReference}: {draft.matterTitle}</Link></td><td>{draft.clientName}</td><td>{formatCalendarDate(draft.dueOn)}</td><td>{pounds(draft.gross)}</td><td>{formatDateTime(draft.updatedAt)}</td></tr>)}</tbody></table>}
    </section>}

    <section aria-labelledby="payments-heading"><h2 id="payments-heading">Client-money payment requests</h2>
      {!payments.body.paymentRequests.length ? <p>No payment requests.</p> : <table className="table"><thead><tr><th scope="col">Request</th><th scope="col">Matter</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Requested</th></tr></thead>
        <tbody>{payments.body.paymentRequests.map((payment) => <tr key={payment.id}><td><Link href={`/finance/payment-requests/${payment.id}`}>{PAYMENT_KIND_LABELS[payment.kind]}</Link></td><td><Link href={`/finance/matters/${payment.matterId}`}>Open finance record</Link></td><td>{pounds(payment.amount)}</td><td>{PAYMENT_STATUS_LABELS[payment.status]}</td><td>{formatDateTime(payment.requestedAt)}</td></tr>)}</tbody></table>}
    </section>

    <section aria-labelledby="rates-heading"><h2 id="rates-heading">Staff rates</h2>
      {!rates.body?.rates.length ? <p>No rates recorded.</p> : <table className="table"><thead><tr><th scope="col">Person</th><th scope="col">Hourly rate</th><th scope="col">Effective from</th><th scope="col">Recorded</th></tr></thead><tbody>{rates.body.rates.map((rate) => <tr key={rate.id}><td>{rate.account.displayName}</td><td>{pounds(rate.hourlyRate)}</td><td>{formatCalendarDate(rate.effectiveFrom)}</td><td>{formatDateTime(rate.createdAt)}</td></tr>)}</tbody></table>}
    </section>

    <section aria-labelledby="statements-heading"><h2 id="statements-heading">Bank statements</h2>
      {!statements.body.statements.length ? <p>No statements imported.</p> : <table className="table"><thead><tr><th scope="col">Account</th><th scope="col">Period</th><th scope="col">Rows</th><th scope="col">Imported</th></tr></thead>
        <tbody>{statements.body.statements.map((statement) => <tr key={statement.id}><td><Link href={`/finance/statements/${statement.id}`}>{bankNames.get(statement.bankAccountId) ?? statement.bankAccountId}</Link></td><td>{formatCalendarDate(statement.periodStart)} to {formatCalendarDate(statement.periodEnd)}</td><td>{statement.rowCount}</td><td>{formatDateTime(statement.importedAt)}</td></tr>)}</tbody></table>}
    </section>

    <section aria-labelledby="reconciliations-heading"><h2 id="reconciliations-heading">Client-account reconciliations</h2>
      {!reconciliations.body.reconciliations.length ? <p>No reconciliations prepared.</p> : <table className="table"><thead><tr><th scope="col">As at</th><th scope="col">Bank balance</th><th scope="col">Difference</th><th scope="col">Sign-off</th></tr></thead>
        <tbody>{reconciliations.body.reconciliations.map((item) => <tr key={item.id}><td><Link href={`/finance/reconciliations/${item.id}`}>{formatCalendarDate(item.asOf)}</Link></td><td>{pounds(item.bankBalance)}</td><td>{pounds(item.bankCashbookDifference)}</td><td>{item.signOff ? `Signed ${formatDateTime(item.signOff.signedOffAt)}` : 'Awaiting Compliance'}</td></tr>)}</tbody></table>}
    </section>
    <FinanceForms access={access.body} bankAccounts={banks.body.bankAccounts} statements={statements.body.statements} rateAccounts={rateAccounts.body?.accounts ?? []} />
  </>;
}

function stateLabel(state: ReconciliationStatus['reconciliation']['state']): string {
  return ({ current: 'Current', warning: 'Due soon', overdue: 'Overdue', not_applicable: 'Not applicable' } as const)[state];
}
