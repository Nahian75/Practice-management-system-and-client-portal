'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { DateFields, TextField, dateFrom } from '@/components/fields';
import type { BankAccount, FinanceAccess, RateAccount, StatementImport } from '@/lib/finance';
import { messagesOf, postJson } from '@/lib/requests';

function ActionForm({ title, children, onSubmit, sending, errors, saved }: {
  title: string; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  sending: boolean; errors?: string[]; saved?: string;
}) {
  const id = title.toLowerCase().replaceAll(/[^a-z]+/g, '-');
  return <form onSubmit={onSubmit} noValidate aria-labelledby={id}><h3 id={id}>{title}</h3>
    {errors && <ErrorSummary messages={errors} />}{saved && <p className="notice" role="status">{saved}</p>}
    {children}<button className="button" type="submit" disabled={sending}>{sending ? 'Saving…' : title}</button></form>;
}

function useSubmission() {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [saved, setSaved] = useState<string>();
  const [sending, setSending] = useState(false);
  async function send(work: () => Promise<Response>, message: string, form?: HTMLFormElement) {
    setSending(true); setErrors(undefined); setSaved(undefined);
    try {
      const response = await work();
      if (!response.ok) { setErrors(await messagesOf(response)); return false; }
      form?.reset(); setSaved(message); router.refresh(); return true;
    } finally { setSending(false); }
  }
  return { errors, setErrors, saved, sending, send };
}

export function FinanceForms({ access, bankAccounts, statements, rateAccounts }: { access: FinanceAccess; bankAccounts: BankAccount[]; statements: StatementImport[]; rateAccounts: RateAccount[] }) {
  return <section aria-labelledby="finance-work-heading"><h2 id="finance-work-heading">Finance work</h2>
    {!access.canRecordClientMoney && !access.canRequestPayment && !access.canReconcile && <p>Compliance access is read-only except for reconciliation sign-off.</p>}
    {access.canManageBilling && <RateForm accounts={rateAccounts} />}
    {access.canRecordClientMoney && <><CreateBankAccount /><RecordReceipt bankAccounts={bankAccounts.filter((item) => !item.closedOn)} /><RecordAllocation /></>}
    {access.canRequestPayment && <RequestPayment bankAccounts={bankAccounts.filter((item) => !item.closedOn)} />}
    {access.canReconcile && <><ImportStatement bankAccounts={bankAccounts.filter((item) => !item.closedOn)} /><PrepareReconciliation statements={statements} /></>}
  </section>;
}

function RateForm({ accounts }: { accounts: RateAccount[] }) {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const effectiveFrom = dateFrom(form, 'effectiveFrom'); if (!effectiveFrom) { state.setErrors(['Enter the effective date']); return; } await state.send(() => postJson('/api/finance/rates', { accountId: String(form.get('rateAccountId')), hourlyRate: String(form.get('hourlyRate')).trim(), effectiveFrom }), 'Staff rate recorded.', element); }
  return <ActionForm title="Add staff rate" onSubmit={submit} {...state}><div className="field"><label className="label" htmlFor="rateAccountId">Partner or fee earner</label><select className="select" id="rateAccountId" name="rateAccountId">{accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.displayName}</option>)}</select></div><TextField name="hourlyRate" label="Hourly rate in GBP" width="short" /><DateFields name="effectiveFrom" legend="Effective from" /></ActionForm>;
}

function CreateBankAccount() {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    const openedOn = dateFrom(form, 'openedOn');
    if (!openedOn) { state.setErrors(['Enter the opening date']); return; }
    await state.send(() => postJson('/api/finance/bank-accounts', {
      kind: String(form.get('kind')), name: String(form.get('name')).trim(), sortCode: String(form.get('sortCode')).trim(),
      accountNumber: String(form.get('accountNumber')).trim(), openedOn,
    }), 'Bank account added.', element);
  }
  return <ActionForm title="Add bank account" onSubmit={submit} {...state}><div className="field"><label className="label" htmlFor="kind">Account type</label><select className="select" id="kind" name="kind"><option value="client">Client account</option><option value="business">Business account</option></select></div>
    <TextField name="name" label="Account name" /><TextField name="sortCode" label="Sort code" hint="Use 12-34-56" width="short" />
    <TextField name="accountNumber" label="Account number" hint="Eight digits" width="short" /><DateFields name="openedOn" legend="Opening date" /></ActionForm>;
}

function BankSelect({ banks, name = 'bankAccountId', label = 'Bank account' }: { banks: BankAccount[]; name?: string; label?: string }) {
  return <div className="field"><label className="label" htmlFor={name}>{label}</label><select className="select" id={name} name={name}>
    {banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name} •••• {bank.lastFour} ({bank.kind})</option>)}</select></div>;
}

function RecordReceipt({ bankAccounts }: { bankAccounts: BankAccount[] }) {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const receivedOn = dateFrom(form, 'receivedOn');
    if (!receivedOn) { state.setErrors(['Enter the received date']); return; }
    await state.send(() => postJson('/api/finance/receipts', { bankAccountId: String(form.get('bankAccountId')), matterId: String(form.get('matterId')).trim(), receivedOn, amount: String(form.get('amount')).trim(), reference: String(form.get('reference')).trim(), purpose: String(form.get('purpose')).trim() }), 'Receipt recorded.', element);
  }
  return <ActionForm title="Record bank-confirmed receipt" onSubmit={submit} {...state}><BankSelect banks={bankAccounts} /><TextField name="matterId" label="Matter id" hint="Copy this from the matter finance record" /><DateFields name="receivedOn" legend="Date received" /><TextField name="amount" label="Amount in GBP" hint="For example 1250.00" width="short" /><TextField name="reference" label="Bank reference" /><TextField name="purpose" label="Purpose" /></ActionForm>;
}

function RecordAllocation() {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); await state.send(() => postJson('/api/finance/allocations', { side: String(form.get('allocationSide')), sourceMatterId: String(form.get('sourceMatterId')).trim(), targetMatterId: String(form.get('targetMatterId')).trim(), amount: String(form.get('allocationAmount')).trim(), reason: String(form.get('allocationReason')).trim() }), 'Allocation correction recorded.', element); }
  return <ActionForm title="Correct a matter allocation" onSubmit={submit} {...state}><div className="field"><label className="label" htmlFor="allocationSide">Ledger side</label><select className="select" id="allocationSide" name="allocationSide"><option value="client">Client money</option><option value="business">Business money</option></select></div><TextField name="sourceMatterId" label="Source matter id" /><TextField name="targetMatterId" label="Target matter id (same client)" /><TextField name="allocationAmount" label="Amount in GBP" width="short" /><TextField name="allocationReason" label="Correction reason" /></ActionForm>;
}

function RequestPayment({ bankAccounts }: { bankAccounts: BankAccount[] }) {
  const state = useSubmission();
  const [kind, setKind] = useState<'refund' | 'third_party' | 'costs_transfer'>('refund');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    const common = { kind, matterId: String(form.get('paymentMatterId')).trim(), clientBankAccountId: String(form.get('clientBankAccountId')),
      evidenceDocumentId: String(form.get('evidenceDocumentId')).trim(), purpose: String(form.get('paymentPurpose')).trim(), amount: String(form.get('paymentAmount')).trim(),
    };
    const details = kind === 'costs_transfer'
      ? { ...common, businessBankAccountId: String(form.get('businessBankAccountId')), billId: String(form.get('billId')).trim() }
      : { ...common, payee: { name: String(form.get('payeeName')).trim(), sortCode: String(form.get('payeeSortCode')).trim(), accountNumber: String(form.get('payeeAccountNumber')).trim() } };
    await state.send(() => postJson('/api/finance/payment-requests', details), 'Payment request created.', element);
  }
  return <ActionForm title="Request client-account payment" onSubmit={submit} {...state}><div className="field"><label className="label" htmlFor="paymentKind">Payment type</label><select className="select" id="paymentKind" name="paymentKind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="refund">Client refund</option><option value="third_party">Third-party payment</option><option value="costs_transfer">Transfer billed costs</option></select></div>
    <BankSelect banks={bankAccounts.filter((bank) => bank.kind === 'client')} name="clientBankAccountId" label="Client bank account" /><TextField name="paymentMatterId" label="Matter id" /><TextField name="evidenceDocumentId" label="Supporting document id" /><TextField name="paymentPurpose" label="Proper purpose" /><TextField name="paymentAmount" label="Amount in GBP" width="short" />
    {kind === 'costs_transfer' ? <><BankSelect banks={bankAccounts.filter((bank) => bank.kind === 'business')} name="businessBankAccountId" label="Business bank account" /><TextField name="billId" label="Issued bill id" /></> : <><TextField name="payeeName" label="Payee name" /><TextField name="payeeSortCode" label="Payee sort code" width="short" /><TextField name="payeeAccountNumber" label="Payee account number" width="short" /></>}</ActionForm>;
}

function ImportStatement({ bankAccounts }: { bankAccounts: BankAccount[] }) {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element);
    const periodStart = dateFrom(form, 'periodStart'); const periodEnd = dateFrom(form, 'periodEnd'); const file = form.get('file');
    if (!periodStart || !periodEnd || !(file instanceof File) || !file.size) { state.setErrors(['Enter the statement period and choose a CSV file']); return; }
    const body = new FormData(); body.set('bankAccountId', String(form.get('statementBankAccountId'))); body.set('periodStart', periodStart); body.set('periodEnd', periodEnd); body.set('openingBalance', String(form.get('openingBalance')).trim()); body.set('closingBalance', String(form.get('closingBalance')).trim()); body.set('file', file);
    await state.send(() => fetch('/api/finance/statement-imports', { method: 'POST', body }), 'Statement imported.', element);
  }
  return <ActionForm title="Import bank statement" onSubmit={submit} {...state}><BankSelect banks={bankAccounts} name="statementBankAccountId" /><DateFields name="periodStart" legend="Period start" /><DateFields name="periodEnd" legend="Period end" /><TextField name="openingBalance" label="Opening balance in GBP" width="short" /><TextField name="closingBalance" label="Closing balance in GBP" width="short" /><div className="field"><label className="label" htmlFor="file">Statement CSV</label><span className="hint" id="file-hint">Header: date,amount,reference,description. Maximum 5 MB and 10,000 rows.</span><input className="input" id="file" name="file" type="file" accept=".csv,text/csv" aria-describedby="file-hint" /></div></ActionForm>;
}

function PrepareReconciliation({ statements }: { statements: StatementImport[] }) {
  const state = useSubmission();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); const asOf = dateFrom(form, 'asOf');
    if (!asOf) { state.setErrors(['Enter the reconciliation date']); return; }
    const explanations: Record<string, string> = {};
    for (const line of String(form.get('explanations')).split('\n')) { const split = line.indexOf(':'); if (split > 0) explanations[line.slice(0, split).trim()] = line.slice(split + 1).trim(); }
    await state.send(() => postJson('/api/finance/reconciliations', { asOf, statementImportIds: form.getAll('statementImportIds').map(String), explanations }), 'Reconciliation prepared.', element);
  }
  return <ActionForm title="Prepare client-account reconciliation" onSubmit={submit} {...state}><DateFields name="asOf" legend="Reconcile as at" /><fieldset className="fieldset"><legend>Client-account statements ending on that date</legend><div className="checkbox">{statements.map((statement) => <label key={statement.id}><input type="checkbox" name="statementImportIds" value={statement.id} />{statement.fileName}: {statement.periodEnd}</label>)}</div></fieldset><div className="field"><label className="label" htmlFor="explanations">Outstanding-item explanations</label><span className="hint" id="explanations-hint">One per line as source key: explanation. Copy statement:… keys from a statement and cashbook:… keys from a cash book. Leave empty only when everything matches.</span><textarea className="input" id="explanations" name="explanations" rows={5} aria-describedby="explanations-hint" /></div></ActionForm>;
}
