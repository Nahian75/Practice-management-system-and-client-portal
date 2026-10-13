'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import { formatDate } from '@/lib/format';
import type { EngagementDocument } from '@/lib/portal';
import { messagesOf, postJson } from '@/lib/requests';

const PORTAL_STATE_BADGES: Record<string, { label: string; className: string }> = {
  sent: { label: 'Awaiting your signature', className: 'badge badge-warning' },
  viewed: { label: 'Awaiting your signature', className: 'badge badge-warning' },
  signed: { label: 'Signed (under legal review)', className: 'badge badge-info' },
  verified: { label: 'Countersigned & active', className: 'badge badge-success' },
  declined: { label: 'Declined', className: 'badge badge-danger' },
  expired: { label: 'Expired', className: 'badge badge-danger' },
};

export function PortalEngagementDocuments({ documents }: { documents: EngagementDocument[] }) {
  const router = useRouter();
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [showDeclineId, setShowDeclineId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  async function handleOpenDoc(doc: EngagementDocument) {
    if (selectedDocId === doc.id) {
      setSelectedDocId(null);
      return;
    }
    setSelectedDocId(doc.id);
    setShowDeclineId(null);
    setErrors(undefined);
    setStatusMsg(undefined);

    // If document is in 'sent' state, viewing it triggers state update to 'viewed'
    if (doc.state === 'sent') {
      try {
        await fetch(`/api/portal/engagement-documents/${doc.id}`);
        router.refresh();
      } catch {
        // Silent fail on view ping
      }
    }
  }

  async function handleSign(e: FormEvent<HTMLFormElement>, docId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const signerName = String(form.get('signerName') ?? '').trim();
    const confirmed = form.get('confirmed') === 'on';

    if (!signerName) {
      setErrors(['Please enter your full legal name']);
      setSaving(false);
      return;
    }

    if (!confirmed) {
      setErrors(['Please confirm that you have read and agreed to the document terms']);
      setSaving(false);
      return;
    }

    try {
      const res = await postJson(`/api/portal/engagement-documents/${docId}/sign`, {
        signerName,
        signerRole: 'client',
        signatureMethod: 'portal_drawn',
        metadata: {
          clientConfirmation: true,
          confirmedAt: new Date().toISOString(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'portal',
        },
      });

      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }

      setStatusMsg('Document successfully signed. Your legal team has been notified.');
      setSelectedDocId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to sign document. Please try again.']);
    } finally {
      setSaving(false);
    }
  }

  async function handleDecline(e: FormEvent<HTMLFormElement>, docId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const reason = String(form.get('reason') ?? '').trim();
    if (!reason) {
      setErrors(['Please provide a reason for declining']);
      setSaving(false);
      return;
    }

    try {
      const res = await postJson(`/api/portal/engagement-documents/${docId}/decline`, {
        reason,
      });

      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }

      setStatusMsg('Document declined. Your legal team has been notified.');
      setShowDeclineId(null);
      setSelectedDocId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to decline document. Please try again.']);
    } finally {
      setSaving(false);
    }
  }

  if (documents.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="portal-engagement-heading" className="panel mb-6">
      <h2 id="portal-engagement-heading">Letters of Authority & Client Care Terms</h2>
      <p className="secondary mb-4">
        Review, verify, and electronically sign the legal authority and engagement documents prepared by your law firm.
      </p>

      {errors && <ErrorSummary messages={errors} />}
      {statusMsg && (
        <div className="notice notice-success mb-4" role="status">
          {statusMsg}
        </div>
      )}

      <div className="space-y-4">
        {documents.map((doc) => {
          const badge = PORTAL_STATE_BADGES[doc.state] ?? { label: doc.state, className: 'badge' };
          const isSelected = selectedDocId === doc.id;
          const isAwaitingSignature = doc.state === 'sent' || doc.state === 'viewed';

          return (
            <div key={doc.id} className="border rounded p-4 bg-white shadow-sm">
              <div className="flex flex-wrap justify-between items-start gap-2 mb-2">
                <div>
                  <h3 className="text-base font-semibold text-gray-900 inline-block mr-2">
                    {doc.title}
                  </h3>
                  <span className={badge.className}>{badge.label}</span>
                </div>
                <div className="text-xs text-secondary font-mono bg-gray-50 px-2 py-1 rounded">
                  Digest: {doc.contentHash.slice(0, 12)}...
                </div>
              </div>

              <div className="text-xs text-secondary mb-3 space-y-1">
                <div>Issued by {doc.generatedBy.displayName} on {formatDate(doc.generatedAt)}</div>
                {doc.expiresAt && <div>Valid until {formatDate(doc.expiresAt)}</div>}
                {doc.declinedAt && (
                  <div className="text-red-700">Declined on {formatDate(doc.declinedAt)}: {doc.declineReason}</div>
                )}
                {doc.signature && (
                  <div className="text-green-800 font-medium">
                    Signed by {doc.signature.signerName} on {formatDate(doc.signature.signedAt)}
                    {doc.signature.review && doc.signature.review.outcome === 'accepted' && (
                      <span> · Verified by legal team on {formatDate(doc.signature.review.reviewedAt)}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => handleOpenDoc(doc)}
                  aria-expanded={isSelected}
                >
                  {isSelected ? 'Close Document' : isAwaitingSignature ? 'Review & Sign' : 'View Document'}
                </button>
              </div>

              {isSelected && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <div className="p-4 bg-gray-50 rounded border mb-4 text-xs font-mono">
                    <div className="flex justify-between items-center mb-2 pb-1 border-b border-gray-200">
                      <span className="font-semibold text-gray-700 uppercase">Document Content & Terms</span>
                      <span className="text-gray-500">SHA-256: {doc.contentHash}</span>
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-gray-900 text-sm leading-relaxed">
                      {doc.renderedContent}
                    </pre>
                  </div>

                  {isAwaitingSignature && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-4">
                      <h4 className="text-sm font-semibold text-amber-950 mb-2">Electronic Signature</h4>
                      <p className="text-xs text-amber-900 mb-4">
                        By confirming your name and ticking the box below, you affix your electronic signature with legal effect.
                      </p>

                      <form onSubmit={(e) => handleSign(e, doc.id)} noValidate>
                        <div className="field mb-3">
                          <label className="label text-xs font-semibold" htmlFor={`signerName_${doc.id}`}>
                            Your Full Legal Name
                          </label>
                          <input
                            id={`signerName_${doc.id}`}
                            name="signerName"
                            className="input"
                            required
                            placeholder="e.g. Johnathan Smith"
                          />
                        </div>

                        <div className="checkbox mb-4">
                          <label className="text-xs flex items-center gap-2">
                            <input type="checkbox" name="confirmed" required />
                            I confirm that I am authorised to sign and agree to all terms stated above.
                          </label>
                        </div>

                        <div className="flex items-center gap-3">
                          <button className="button button-success" type="submit" disabled={saving}>
                            {saving ? 'Signing...' : 'Affix Signature & Agree'}
                          </button>
                          <button
                            type="button"
                            className="button button-subtle text-red-700"
                            onClick={() => setShowDeclineId(showDeclineId === doc.id ? null : doc.id)}
                          >
                            Decline terms...
                          </button>
                        </div>
                      </form>

                      {showDeclineId === doc.id && (
                        <form
                          onSubmit={(e) => handleDecline(e, doc.id)}
                          className="mt-4 p-3 bg-red-50 border border-red-200 rounded"
                        >
                          <h5 className="text-xs font-semibold text-red-900 mb-2">Decline Agreement</h5>
                          <div className="field mb-2">
                            <label className="label text-xs" htmlFor={`declineReason_${doc.id}`}>
                              State your reason for declining
                            </label>
                            <textarea
                              id={`declineReason_${doc.id}`}
                              name="reason"
                              rows={2}
                              required
                              className="input"
                              placeholder="e.g. Fee arrangement needs discussion"
                            />
                          </div>
                          <button className="button bg-red-700 text-white button-small" type="submit" disabled={saving}>
                            {saving ? 'Declining...' : 'Confirm Decline'}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
