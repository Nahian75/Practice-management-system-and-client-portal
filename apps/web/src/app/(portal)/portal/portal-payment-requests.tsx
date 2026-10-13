'use client';

import { useState } from 'react';
import type { PortalPaymentRequest } from '@/lib/portal';
import { PAYMENT_KIND_LABELS, penceToPounds } from '@/lib/onboarding';
import { formatCalendarDate, formatDate } from '@/lib/format';

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending: { label: 'Awaiting your payment', className: 'badge badge-warning' },
  paid: { label: 'Paid & reconciled', className: 'badge badge-success' },
  waived: { label: 'Waived by firm', className: 'badge badge-info' },
  cancelled: { label: 'Cancelled', className: 'badge badge-danger' },
};

export function PortalPaymentRequests({ requests }: { requests: PortalPaymentRequest[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (requests.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="portal-payments-heading" style={{ marginBottom: '32px' }}>
      <div className="section-header">
        <h2 id="portal-payments-heading">Payment requests & deposits on account</h2>
        <p className="secondary">
          Initial deposits and fee payments requested by your legal team to begin or progress work on your matters.
        </p>
      </div>

      <div style={{ display: 'grid', gap: '16px' }}>
        {requests.map((req) => {
          const isPending = req.status === 'pending';
          const isExpanded = expandedId === req.id;
          const bank = (req.bankAccountDetails as Record<string, string> | null) ?? null;

          return (
            <div
              key={req.id}
              className="card"
              style={{
                padding: '20px',
                borderLeft: isPending ? '4px solid var(--color-warning, #f59e0b)' : undefined,
                backgroundColor: 'var(--color-surface, #fff)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                    <code style={{ fontSize: '1.05em', fontWeight: 600 }}>{req.reference}</code>
                    <span className={STATUS_BADGES[req.status]?.className ?? 'badge'}>
                      {STATUS_BADGES[req.status]?.label ?? req.status}
                    </span>
                  </div>
                  <h3 style={{ margin: '4px 0 6px 0', fontSize: '1.15em' }}>{req.description}</h3>
                  <div className="secondary" style={{ fontSize: '0.9em' }}>
                    <span>{PAYMENT_KIND_LABELS[req.kind]}</span> • <span>Due by {formatCalendarDate(req.dueOn)}</span>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.4em', fontWeight: 700, color: 'var(--color-text, #111)' }}>
                    {penceToPounds(req.amountPence)}
                  </div>
                  {isPending && (
                    <button
                      type="button"
                      className="button button-small button-primary"
                      style={{ marginTop: '8px' }}
                      onClick={() => setExpandedId(isExpanded ? null : req.id)}
                    >
                      {isExpanded ? 'Hide payment details' : 'View bank transfer details'}
                    </button>
                  )}
                </div>
              </div>

              {/* Paid Status Details */}
              {req.status === 'paid' && req.paidAt && (
                <div style={{ marginTop: '12px', padding: '10px 14px', backgroundColor: 'var(--color-bg-subtle, #f0fdf4)', borderRadius: '6px' }}>
                  <p style={{ margin: 0, color: '#166534', fontSize: '0.95em' }}>
                    ✓ <strong>Received & Reconciled: </strong>
                    Payment confirmed on {formatDate(req.paidAt)}
                    {req.paidReference ? ` (Reference: ${req.paidReference})` : ''}.
                  </p>
                </div>
              )}

              {/* Pending Bank Details Panel */}
              {isPending && isExpanded && bank && (
                <div
                  style={{
                    marginTop: '16px',
                    padding: '16px',
                    borderRadius: '8px',
                    backgroundColor: 'var(--color-bg-subtle, #f8f9fa)',
                    border: '1px solid var(--color-border, #e5e7eb)',
                  }}
                >
                  <h4 style={{ margin: '0 0 10px 0' }}>How to pay by UK Bank Transfer (BACS / Faster Payments)</h4>
                  <p className="secondary" style={{ marginBottom: '14px' }}>
                    Please transfer the exact amount using online or mobile banking quoting your unique payment reference:
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '14px' }}>
                    <div>
                      <span className="secondary" style={{ fontSize: '0.85em', display: 'block' }}>Payment Reference</span>
                      <strong style={{ fontSize: '1.1em', letterSpacing: '0.5px' }}>{req.reference}</strong>
                    </div>
                    <div>
                      <span className="secondary" style={{ fontSize: '0.85em', display: 'block' }}>Account Name</span>
                      <strong>{bank.accountName || 'Stass Law Client Account'}</strong>
                    </div>
                    <div>
                      <span className="secondary" style={{ fontSize: '0.85em', display: 'block' }}>Sort Code</span>
                      <strong>{bank.sortCode || '20-00-00'}</strong>
                    </div>
                    <div>
                      <span className="secondary" style={{ fontSize: '0.85em', display: 'block' }}>Account Number</span>
                      <strong>{bank.accountNumber || '55667788'}</strong>
                    </div>
                    {bank.bankName && (
                      <div>
                        <span className="secondary" style={{ fontSize: '0.85em', display: 'block' }}>Bank</span>
                        <strong>{bank.bankName}</strong>
                      </div>
                    )}
                  </div>

                  <p className="secondary" style={{ margin: 0, fontSize: '0.85em', fontStyle: 'italic' }}>
                    Note: Client money is held in a protected statutory client account in accordance with the SRA Accounts Rules. Once your payment appears on our bank statement, staff will match and reconcile it.
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <hr className="rule" />
    </section>
  );
}
