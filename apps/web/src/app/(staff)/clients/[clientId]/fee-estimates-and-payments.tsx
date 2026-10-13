'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type { MatterSummary } from '@/lib/matters';
import {
  type MatterFeeEstimate,
  type OnboardingPaymentRequest,
  type OnboardingPaymentMethod,
  type OnboardingPaymentRequestKind,
  CHARGING_BASIS_LABELS,
  PAYMENT_KIND_LABELS,
  PAYMENT_METHOD_LABELS,
  penceToPounds,
  poundsToPence,
} from '@/lib/onboarding';
import { formatCalendarDate, formatDate } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

const PAYMENT_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending payment', className: 'badge badge-warning' },
  paid: { label: 'Paid & reconciled', className: 'badge badge-success' },
  waived: { label: 'Waived', className: 'badge badge-info' },
  cancelled: { label: 'Cancelled', className: 'badge badge-danger' },
};

export function FeeEstimatesAndPayments({
  clientId,
  matters,
  paymentRequests,
  feeEstimates = [],
}: {
  clientId: string;
  matters: MatterSummary[];
  paymentRequests: OnboardingPaymentRequest[];
  feeEstimates?: MatterFeeEstimate[];
}) {
  const router = useRouter();

  const [openEstimateForm, setOpenEstimateForm] = useState(false);
  const [openPaymentForm, setOpenPaymentForm] = useState(false);
  const [receiptingReqId, setReceiptingReqId] = useState<string | null>(null);
  const [waivingReqId, setWaivingReqId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  // Calculator helper state for live total preview in estimate form
  const [estFees, setEstFees] = useState('0.00');
  const [estDisb, setEstDisb] = useState('0.00');
  const [estVat, setEstVat] = useState('0.00');

  const calcTotalPence = poundsToPence(estFees) + poundsToPence(estDisb) + poundsToPence(estVat);

  async function handleCreateEstimate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const matterId = String(form.get('matterId') || '');
    if (!matterId) {
      setErrors(['Please select a matter for this fee estimate']);
      setSaving(false);
      return;
    }

    const chargingBasis = String(form.get('chargingBasis') || 'fixed');
    const feesPence = poundsToPence(String(form.get('fees') || '0'));
    const disbPence = poundsToPence(String(form.get('disbursements') || '0'));
    const vatPence = poundsToPence(String(form.get('vat') || '0'));
    const budgetLimitStr = String(form.get('budgetLimit') || '').trim();
    const budgetLimitPence = budgetLimitStr ? poundsToPence(budgetLimitStr) : null;
    const assumptions = String(form.get('assumptions') || '').trim();
    const agreedWithClient = form.get('agreedWithClient') === 'on';

    if (!assumptions) {
      setErrors(['Please enter the scope assumptions and charging terms']);
      setSaving(false);
      return;
    }

    const response = await postJson(`/api/matters/${encodeURIComponent(matterId)}/fee-estimates`, {
      chargingBasis,
      estimatedFeesPence: feesPence.toString(),
      estimatedDisbursementsPence: disbPence.toString(),
      estimatedVatPence: vatPence.toString(),
      budgetLimitPence: budgetLimitPence !== null ? budgetLimitPence.toString() : null,
      assumptions,
      agreedWithClient,
    });

    setSaving(false);
    if (!response.ok) {
      setErrors(await messagesOf(response));
      return;
    }

    setStatusMsg('Matter fee estimate successfully recorded.');
    setOpenEstimateForm(false);
    router.refresh();
  }

  async function handleCreatePaymentRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const matterId = String(form.get('matterId') || '') || null;
    const kind = String(form.get('kind') || 'deposit_on_account') as OnboardingPaymentRequestKind;
    const description = String(form.get('description') || '').trim();
    const amountStr = String(form.get('amount') || '').trim();
    const dueOn = String(form.get('dueOn') || '').trim();

    const accountName = String(form.get('bankAccountName') || '').trim();
    const sortCode = String(form.get('bankSortCode') || '').trim();
    const accountNumber = String(form.get('bankAccountNumber') || '').trim();
    const bankName = String(form.get('bankName') || '').trim();

    if (!description || !amountStr || !dueOn) {
      setErrors(['Please fill in the description, amount and due date']);
      setSaving(false);
      return;
    }

    const amountPence = poundsToPence(amountStr);
    if (amountPence <= 0n) {
      setErrors(['Payment request amount must be greater than zero']);
      setSaving(false);
      return;
    }

    const bankAccountDetails = accountName && accountNumber ? {
      accountName,
      sortCode,
      accountNumber,
      bankName,
    } : null;

    const response = await postJson(`/api/clients/${encodeURIComponent(clientId)}/payment-requests`, {
      matterId,
      kind,
      description,
      amountPence: amountPence.toString(),
      dueOn,
      bankAccountDetails,
    });

    setSaving(false);
    if (!response.ok) {
      setErrors(await messagesOf(response));
      return;
    }

    setStatusMsg('Initial payment request created successfully.');
    setOpenPaymentForm(false);
    router.refresh();
  }

  async function handleRecordReceipt(e: FormEvent<HTMLFormElement>, requestId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const paymentMethod = String(form.get('paymentMethod') || 'bank_transfer') as OnboardingPaymentMethod;
    const reference = String(form.get('reference') || '').trim();
    const notes = String(form.get('notes') || '').trim() || null;

    if (!reference) {
      setErrors(['Please provide a bank statement / transaction reference']);
      setSaving(false);
      return;
    }

    const response = await postJson(
      `/api/clients/${encodeURIComponent(clientId)}/payment-requests/${encodeURIComponent(requestId)}/receipt`,
      {
        paymentMethod,
        reference,
        notes,
      },
    );

    setSaving(false);
    if (!response.ok) {
      setErrors(await messagesOf(response));
      return;
    }

    setStatusMsg('Payment receipt successfully recorded and reconciled.');
    setReceiptingReqId(null);
    router.refresh();
  }

  async function handleWaiveRequest(e: FormEvent<HTMLFormElement>, requestId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const reason = String(form.get('reason') || '').trim();
    if (!reason) {
      setErrors(['Please state the reason for waiving this payment requirement']);
      setSaving(false);
      return;
    }

    const response = await postJson(
      `/api/clients/${encodeURIComponent(clientId)}/payment-requests/${encodeURIComponent(requestId)}/waive`,
      { reason },
    );

    setSaving(false);
    if (!response.ok) {
      setErrors(await messagesOf(response));
      return;
    }

    setStatusMsg('Payment request waived.');
    setWaivingReqId(null);
    router.refresh();
  }

  return (
    <section aria-labelledby="fee-estimates-payments-heading">
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 id="fee-estimates-payments-heading">Fee estimates, budgets & initial payments</h2>
          <p className="secondary">
            Statutory fee estimates, budget limit ceilings, and provider-neutral initial payments / deposit on account handoff.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {matters.length > 0 && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setOpenEstimateForm(!openEstimateForm);
                setOpenPaymentForm(false);
                setErrors(undefined);
              }}
            >
              {openEstimateForm ? 'Close estimate form' : '+ Record fee estimate'}
            </button>
          )}
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              setOpenPaymentForm(!openPaymentForm);
              setOpenEstimateForm(false);
              setErrors(undefined);
            }}
          >
            {openPaymentForm ? 'Close payment form' : '+ Request payment'}
          </button>
        </div>
      </div>

      {errors && <ErrorSummary messages={errors} />}

      {statusMsg && (
        <div className="alert alert-success" role="status" style={{ marginBottom: '16px' }}>
          {statusMsg}
        </div>
      )}

      {/* Form: Record Matter Fee Estimate */}
      {openEstimateForm && (
        <div className="card" style={{ padding: '20px', marginBottom: '24px', backgroundColor: 'var(--color-surface, #fff)' }}>
          <h3>Record matter fee estimate & budget</h3>
          <p className="secondary">
            Fee estimates are immutable once created. Subsequent revisions create versioned entries and supersede previous active estimates.
          </p>
          <form onSubmit={handleCreateEstimate}>
            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label htmlFor="est-matter">Matter *</label>
              <select id="est-matter" name="matterId" required className="input" defaultValue={matters[0]?.id}>
                {matters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.reference} - {m.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label htmlFor="est-basis">Charging basis *</label>
              <select id="est-basis" name="chargingBasis" required className="input" defaultValue="fixed">
                <option value="fixed">Fixed fee</option>
                <option value="hourly">Hourly rates</option>
                <option value="capped">Capped fee</option>
                <option value="contingency">Damages-based / contingency</option>
                <option value="pro_bono">Pro bono</option>
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <div className="form-group">
                <label htmlFor="est-fees">Estimated fees (£) *</label>
                <input
                  id="est-fees"
                  name="fees"
                  type="text"
                  required
                  className="input"
                  value={estFees}
                  onChange={(e) => setEstFees(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="est-disb">Estimated disbursements (£)</label>
                <input
                  id="est-disb"
                  name="disbursements"
                  type="text"
                  className="input"
                  value={estDisb}
                  onChange={(e) => setEstDisb(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="est-vat">Estimated VAT (£)</label>
                <input
                  id="est-vat"
                  name="vat"
                  type="text"
                  className="input"
                  value={estVat}
                  onChange={(e) => setEstVat(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="est-budget">Budget limit / ceiling (£)</label>
                <input
                  id="est-budget"
                  name="budgetLimit"
                  type="text"
                  className="input"
                  placeholder="Optional limit"
                />
              </div>
            </div>

            <div style={{ padding: '10px 14px', backgroundColor: 'var(--color-bg-subtle, #f8f9fa)', borderRadius: '6px', marginBottom: '12px' }}>
              <strong>Calculated Total Estimate: </strong>
              <span style={{ fontSize: '1.1em', fontWeight: 600 }}>{penceToPounds(calcTotalPence)}</span>
              <span className="secondary" style={{ marginLeft: '12px' }}>
                (Fees + Disbursements + VAT in exact integer pence)
              </span>
            </div>

            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label htmlFor="est-assumptions">Scope assumptions & terms *</label>
              <textarea
                id="est-assumptions"
                name="assumptions"
                rows={3}
                required
                className="input"
                placeholder="Key assumptions, stages included, disbursements anticipated..."
              />
            </div>

            <div className="form-group" style={{ marginBottom: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="checkbox" name="agreedWithClient" defaultChecked />
                <span>Estimate communicated and agreed with client in client-care terms</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" className="button button-primary" disabled={saving}>
                {saving ? 'Recording...' : 'Record Fee Estimate'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setOpenEstimateForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Form: Create Onboarding Payment Request */}
      {openPaymentForm && (
        <div className="card" style={{ padding: '20px', marginBottom: '24px', backgroundColor: 'var(--color-surface, #fff)' }}>
          <h3>Request onboarding payment / deposit</h3>
          <p className="secondary">
            Issues a formal payment request visible in the client portal with firm bank account details.
          </p>
          <form onSubmit={handleCreatePaymentRequest}>
            {matters.length > 0 && (
              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label htmlFor="pay-matter">Associated matter (optional)</label>
                <select id="pay-matter" name="matterId" className="input" defaultValue="">
                  <option value="">General client onboarding</option>
                  {matters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.reference} - {m.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <div className="form-group">
                <label htmlFor="pay-kind">Payment type *</label>
                <select id="pay-kind" name="kind" required className="input" defaultValue="deposit_on_account">
                  <option value="deposit_on_account">Deposit on account (client money)</option>
                  <option value="initial_fixed_fee">Initial fixed fee (office money)</option>
                  <option value="consultation">Initial consultation fee</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="pay-amount">Amount (£) *</label>
                <input id="pay-amount" name="amount" type="text" required className="input" placeholder="e.g. 500.00" />
              </div>

              <div className="form-group">
                <label htmlFor="pay-due">Due date *</label>
                <input
                  id="pay-due"
                  name="dueOn"
                  type="date"
                  required
                  className="input"
                  defaultValue={new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)}
                />
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label htmlFor="pay-desc">Description *</label>
              <input
                id="pay-desc"
                name="description"
                type="text"
                required
                className="input"
                placeholder="e.g. Deposit on account for initial search fees and counsel advice"
              />
            </div>

            <h4 style={{ marginTop: '16px', marginBottom: '8px' }}>Bank Transfer Details for Client</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
              <div className="form-group">
                <label htmlFor="pay-bank-name">Bank name</label>
                <input id="pay-bank-name" name="bankName" type="text" className="input" defaultValue="Barclays Bank UK" />
              </div>

              <div className="form-group">
                <label htmlFor="pay-bank-acc">Account name</label>
                <input id="pay-bank-acc" name="bankAccountName" type="text" className="input" defaultValue="Stass Law Client Account" />
              </div>

              <div className="form-group">
                <label htmlFor="pay-bank-sort">Sort code</label>
                <input id="pay-bank-sort" name="bankSortCode" type="text" className="input" defaultValue="20-00-00" />
              </div>

              <div className="form-group">
                <label htmlFor="pay-bank-num">Account number</label>
                <input id="pay-bank-num" name="bankAccountNumber" type="text" className="input" defaultValue="55667788" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="submit" className="button button-primary" disabled={saving}>
                {saving ? 'Creating...' : 'Create Payment Request'}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setOpenPaymentForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Matter Fee Estimates Display */}
      {feeEstimates.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <h3>Matter Fee Estimates</h3>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Charging Basis</th>
                <th scope="col">Fees</th>
                <th scope="col">Disbursements</th>
                <th scope="col">VAT</th>
                <th scope="col">Total</th>
                <th scope="col">Budget Limit</th>
                <th scope="col">Status</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {feeEstimates.map((est) => (
                <tr key={est.id}>
                  <td>v{est.version}</td>
                  <td>{CHARGING_BASIS_LABELS[est.chargingBasis]}</td>
                  <td>{penceToPounds(est.estimatedFeesPence)}</td>
                  <td>{penceToPounds(est.estimatedDisbursementsPence)}</td>
                  <td>{penceToPounds(est.estimatedVatPence)}</td>
                  <td><strong>{penceToPounds(est.totalEstimatePence)}</strong></td>
                  <td>{est.budgetLimitPence ? penceToPounds(est.budgetLimitPence) : 'None'}</td>
                  <td>
                    <span className={est.status === 'active' ? 'badge badge-success' : 'badge'}>
                      {est.status === 'active' ? 'Active' : 'Superseded'}
                    </span>
                  </td>
                  <td>
                    {formatDate(est.createdAt)} <span className="secondary">by {est.createdBy.displayName}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Onboarding Payment Requests Table */}
      <div>
        <h3>Onboarding Payment Requests</h3>
        {paymentRequests.length === 0 ? (
          <p className="secondary">No initial payment requests or deposits on account recorded.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Type</th>
                <th scope="col">Description</th>
                <th scope="col">Amount</th>
                <th scope="col">Due Date</th>
                <th scope="col">Status</th>
                <th scope="col">Actions & Outcome</th>
              </tr>
            </thead>
            <tbody>
              {paymentRequests.map((req) => (
                <tr key={req.id}>
                  <td><code>{req.reference}</code></td>
                  <td>{PAYMENT_KIND_LABELS[req.kind]}</td>
                  <td>{req.description}</td>
                  <td><strong>{penceToPounds(req.amountPence)}</strong></td>
                  <td>{formatCalendarDate(req.dueOn)}</td>
                  <td>
                    <span className={PAYMENT_STATUS_BADGES[req.status]?.className ?? 'badge'}>
                      {PAYMENT_STATUS_BADGES[req.status]?.label ?? req.status}
                    </span>
                  </td>
                  <td>
                    {req.status === 'pending' && (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="button button-small button-primary"
                          onClick={() => {
                            setReceiptingReqId(req.id);
                            setWaivingReqId(null);
                          }}
                        >
                          Record receipt
                        </button>
                        <button
                          type="button"
                          className="button button-small button-secondary"
                          onClick={() => {
                            setWaivingReqId(req.id);
                            setReceiptingReqId(null);
                          }}
                        >
                          Waive
                        </button>
                      </div>
                    )}
                    {req.status === 'paid' && (
                      <span className="secondary">
                        Paid on {req.paidAt ? formatDate(req.paidAt) : ''} via {PAYMENT_METHOD_LABELS[req.paymentMethod || 'bank_transfer']}
                        {req.paidReference ? ` (Ref: ${req.paidReference})` : ''}
                      </span>
                    )}
                    {req.status === 'waived' && (
                      <span className="secondary">Waived: {req.notes || 'By partner approval'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Modal/Panel: Record Receipt */}
        {receiptingReqId && (
          <div className="card" style={{ padding: '16px', marginTop: '16px', backgroundColor: 'var(--color-bg-subtle, #f8f9fa)' }}>
            <h4>Record Payment Receipt & Bank Reconciliation</h4>
            <form onSubmit={(e) => handleRecordReceipt(e, receiptingReqId)}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                <div className="form-group">
                  <label htmlFor="rec-method">Payment method *</label>
                  <select id="rec-method" name="paymentMethod" required className="input" defaultValue="bank_transfer">
                    <option value="bank_transfer">Bank transfer</option>
                    <option value="card">Card</option>
                    <option value="cheque">Cheque</option>
                    <option value="cash">Cash</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="rec-ref">Bank / transaction reference *</label>
                  <input
                    id="rec-ref"
                    name="reference"
                    type="text"
                    required
                    className="input"
                    placeholder="e.g. BACS-987654 or Bank Stmt Row #12"
                  />
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label htmlFor="rec-notes">Audit notes</label>
                <input
                  id="rec-notes"
                  name="notes"
                  type="text"
                  className="input"
                  placeholder="e.g. Cleared into client bank account, matched against statement"
                />
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="submit" className="button button-primary" disabled={saving}>
                  {saving ? 'Recording...' : 'Confirm Receipt'}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setReceiptingReqId(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Modal/Panel: Waive Request */}
        {waivingReqId && (
          <div className="card" style={{ padding: '16px', marginTop: '16px', backgroundColor: 'var(--color-bg-subtle, #f8f9fa)' }}>
            <h4>Waive Onboarding Payment Request</h4>
            <form onSubmit={(e) => handleWaiveRequest(e, waivingReqId)}>
              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label htmlFor="waive-reason">Reason for waiver *</label>
                <textarea
                  id="waive-reason"
                  name="reason"
                  required
                  rows={2}
                  className="input"
                  placeholder="Reasoned partner justification for waiver of deposit/fee requirement..."
                />
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="submit" className="button button-primary" disabled={saving}>
                  {saving ? 'Waiving...' : 'Confirm Waiver'}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setWaivingReqId(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
