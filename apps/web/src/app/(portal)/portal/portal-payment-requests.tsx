'use client';

import { useState } from 'react';
import type { PortalPaymentRequest } from '@/lib/portal';
import { PAYMENT_KIND_LABELS, penceToPounds } from '@/lib/onboarding';
import { formatCalendarDate, formatDate } from '@/lib/format';

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending: { label: 'Awaiting your payment', className: 'badge badge-warning' },
  paid: { label: 'Payment recorded', className: 'badge badge-success' },
  waived: { label: 'Waived by firm', className: 'badge badge-info' },
  cancelled: { label: 'Cancelled', className: 'badge badge-danger' },
};

export function PortalPaymentRequests({ requests }: { requests: PortalPaymentRequest[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (requests.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="portal-payments-heading" className={["portal-payment-rule-1"].filter(Boolean).join(" ")}>
      <div className="section-header">
        <h2 id="portal-payments-heading">Payment requests & deposits on account</h2>
        <p className="secondary">
          Initial deposits and fee payments requested by your legal team to begin or progress work on your matters.
        </p>
      </div>

      <div className={["portal-payment-rule-2","portal-payment-rule-3"].filter(Boolean).join(" ")}>
        {requests.map((req) => {
          const isPending = req.status === 'pending';
          const isExpanded = expandedId === req.id;
          const details = req.bankAccountDetails;
          const bank = details && typeof details.accountName === 'string' && details.accountName.trim() &&
            typeof details.sortCode === 'string' && /^\d{2}-?\d{2}-?\d{2}$/.test(details.sortCode) &&
            typeof details.accountNumber === 'string' && /^\d{8}$/.test(details.accountNumber) ?
            {accountName:details.accountName,sortCode:details.sortCode,accountNumber:details.accountNumber,bankName:typeof details.bankName==='string'?details.bankName:''}:null;

          return (
            <div
              key={req.id}
              
              className={["card","portal-payment-rule-4",(isPending?"portal-payment-rule-5":""),"portal-payment-rule-6"].filter(Boolean).join(" ")}
            >
              <div className={["portal-payment-rule-7","portal-payment-rule-8","portal-payment-rule-9","portal-payment-rule-10","portal-payment-rule-11"].filter(Boolean).join(" ")}>
                <div>
                  <div className={["portal-payment-rule-12","portal-payment-rule-13","portal-payment-rule-14","portal-payment-rule-15"].filter(Boolean).join(" ")}>
                    <code className={["portal-payment-rule-16","portal-payment-rule-17"].filter(Boolean).join(" ")}>{req.reference}</code>
                    <span className={STATUS_BADGES[req.status]?.className ?? 'badge'}>
                      {STATUS_BADGES[req.status]?.label ?? req.status}
                    </span>
                  </div>
                  <h3 className={["portal-payment-rule-18","portal-payment-rule-19"].filter(Boolean).join(" ")}>{req.description}</h3>
                  <div  className={["secondary","portal-payment-rule-20"].filter(Boolean).join(" ")}>
                    <span>{PAYMENT_KIND_LABELS[req.kind]}</span> • <span>Due by {formatCalendarDate(req.dueOn)}</span>
                  </div>
                </div>

                <div className={["portal-payment-rule-21"].filter(Boolean).join(" ")}>
                  <div className={["portal-payment-rule-22","portal-payment-rule-23","portal-payment-rule-24"].filter(Boolean).join(" ")}>
                    {penceToPounds(req.amountPence)}
                  </div>
                  {isPending && (
                    <button
                      type="button"
                      
                      className={["button button-small button-primary","portal-payment-rule-25"].filter(Boolean).join(" ")}
                      onClick={() => setExpandedId(isExpanded ? null : req.id)}
                    >
                      {isExpanded ? 'Hide payment details' : 'View bank transfer details'}
                    </button>
                  )}
                </div>
              </div>

              {/* Paid Status Details */}
              {req.status === 'paid' && req.paidAt && (
                <div className={["portal-payment-rule-26","portal-payment-rule-27","portal-payment-rule-28","portal-payment-rule-29"].filter(Boolean).join(" ")}>
                  <p className={["portal-payment-rule-30","portal-payment-rule-31","portal-payment-rule-32"].filter(Boolean).join(" ")}>
                    ✓ <strong>Payment recorded: </strong>
                    Recorded on {formatDate(req.paidAt)}
                    {req.paidReference ? ` (Reference: ${req.paidReference})` : ''}.
                  </p>
                </div>
              )}

              {/* Pending Bank Details Panel */}
              {isPending && isExpanded && !bank && <p className="notice">Bank transfer details are not available. Contact your legal team using a known contact number before making payment.</p>}
              {isPending && isExpanded && bank && (
                <div
                  className={["portal-payment-rule-33","portal-payment-rule-34","portal-payment-rule-35","portal-payment-rule-36","portal-payment-rule-37"].filter(Boolean).join(" ")}
                >
                  <h4 className={["portal-payment-rule-38"].filter(Boolean).join(" ")}>How to pay by UK Bank Transfer (BACS / Faster Payments)</h4>
                  <p  className={["secondary","portal-payment-rule-39"].filter(Boolean).join(" ")}>
                    Please transfer the exact amount using online or mobile banking quoting your unique payment reference:
                  </p>

                  <div className={["portal-payment-rule-40","portal-payment-rule-41","portal-payment-rule-42","portal-payment-rule-43"].filter(Boolean).join(" ")}>
                    <div>
                      <span  className={["secondary","portal-payment-rule-44","portal-payment-rule-45"].filter(Boolean).join(" ")}>Payment Reference</span>
                      <strong className={["portal-payment-rule-46","portal-payment-rule-47"].filter(Boolean).join(" ")}>{req.reference}</strong>
                    </div>
                    <div>
                      <span  className={["secondary","portal-payment-rule-48","portal-payment-rule-49"].filter(Boolean).join(" ")}>Account Name</span>
                      <strong>{bank.accountName}</strong>
                    </div>
                    <div>
                      <span  className={["secondary","portal-payment-rule-50","portal-payment-rule-51"].filter(Boolean).join(" ")}>Sort Code</span>
                      <strong>{bank.sortCode}</strong>
                    </div>
                    <div>
                      <span  className={["secondary","portal-payment-rule-52","portal-payment-rule-53"].filter(Boolean).join(" ")}>Account Number</span>
                      <strong>{bank.accountNumber}</strong>
                    </div>
                    {bank.bankName && (
                      <div>
                        <span  className={["secondary","portal-payment-rule-54","portal-payment-rule-55"].filter(Boolean).join(" ")}>Bank</span>
                        <strong>{bank.bankName}</strong>
                      </div>
                    )}
                  </div>

                  <p  className={["secondary","portal-payment-rule-56","portal-payment-rule-57","portal-payment-rule-58"].filter(Boolean).join(" ")}>
                    Verify these details with your legal team using a known contact number before making a transfer. A payment request is separate from a bank-reconciled receipt.
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
