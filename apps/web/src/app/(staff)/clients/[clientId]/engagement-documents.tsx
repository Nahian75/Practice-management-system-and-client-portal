'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type {
  EngagementDocument,
  EngagementTemplate,
  SignerRole,
  SignatureMethod,
} from '@/lib/onboarding';
import type { MatterSummary } from '@/lib/matters';
import { formatDate } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

const STATE_BADGES: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'badge' },
  sent: { label: 'Sent to client', className: 'badge badge-info' },
  viewed: { label: 'Viewed by client', className: 'badge badge-warning' },
  signed: { label: 'Signed (pending review)', className: 'badge badge-warning' },
  verified: { label: 'Verified & active', className: 'badge badge-success' },
  declined: { label: 'Declined', className: 'badge badge-danger' },
  expired: { label: 'Expired', className: 'badge badge-danger' },
};

const TEMPLATE_KEY_NAMES: Record<string, string> = {
  letter_of_authority: 'Letter of Authority',
  client_care_letter: 'Client Care Letter',
  fee_agreement: 'Fee Agreement',
};

const SIGNER_ROLE_LABELS: Record<SignerRole, string> = {
  client: 'Client (Primary)',
  representative: 'Authorised Representative',
  director: 'Company Director',
  officer: 'Corporate Officer',
};

const SIGNATURE_METHOD_LABELS: Record<SignatureMethod, string> = {
  wet_signature_upload: 'Wet-signature scan / paper upload',
  portal_drawn: 'Client drawn signature in portal',
  provider_electronic: 'E-signature provider confirmation',
};

export function EngagementDocuments({
  clientId,
  clientName,
  documents,
  templates,
  matters,
}: {
  clientId: string;
  clientName: string;
  documents: EngagementDocument[];
  templates: EngagementTemplate[];
  matters: MatterSummary[];
}) {
  const router = useRouter();
  const [openGenerateForm, setOpenGenerateForm] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0]?.id ?? '');
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);
  const [signingDocId, setSigningDocId] = useState<string | null>(null);
  const [reviewingSigId, setReviewingSigId] = useState<string | null>(null);
  const [decliningDocId, setDecliningDocId] = useState<string | null>(null);
  const [sendingDocId, setSendingDocId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  const activeTemplate = templates.find((t) => t.id === selectedTemplateId) ?? templates[0];

  async function handleGenerate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const templateId = String(form.get('templateId'));
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) {
      setErrors(['Please select an engagement template']);
      setSaving(false);
      return;
    }

    const matterId = String(form.get('matterId') || '') || null;
    const title = String(form.get('title') ?? '').trim();

    const fields: Record<string, string> = {};
    for (const field of tpl.allowedFields) {
      fields[field] = String(form.get(`field_${field}`) ?? '').trim();
    }

    try {
      const res = await postJson(`/api/clients/${clientId}/engagement-documents`, {
        templateId,
        matterId,
        title,
        fields,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Engagement document generated successfully.');
      setOpenGenerateForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to generate engagement document']);
    } finally {
      setSaving(false);
    }
  }

  async function handleSend(e: FormEvent<HTMLFormElement>, docId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const expiresDays = Number(form.get('expiresDays') ?? 30);
    const expiresAt = expiresDays > 0 ? new Date(Date.now() + expiresDays * 86400000).toISOString() : null;

    try {
      const res = await postJson(`/api/clients/${clientId}/engagement-documents/${docId}/send`, {
        expiresAt,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Engagement document sent to client.');
      setSendingDocId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to send engagement document']);
    } finally {
      setSaving(false);
    }
  }

  async function handleRecordSignature(e: FormEvent<HTMLFormElement>, docId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    try {
      const res = await postJson(`/api/clients/${clientId}/engagement-documents/${docId}/signatures`, {
        signerName: String(form.get('signerName') ?? '').trim(),
        signerEmail: String(form.get('signerEmail') ?? '').trim() || null,
        signerRole: form.get('signerRole'),
        signatureMethod: form.get('signatureMethod'),
        metadata: {
          referenceNote: String(form.get('referenceNote') ?? '').trim(),
          recordedInPerson: form.get('recordedInPerson') === 'true',
        },
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Signature recorded successfully.');
      setSigningDocId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to record signature']);
    } finally {
      setSaving(false);
    }
  }

  async function handleReviewSignature(e: FormEvent<HTMLFormElement>, sigId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    try {
      const res = await postJson(`/api/clients/${clientId}/engagement-signatures/${sigId}/review`, {
        outcome: form.get('outcome'),
        reason: String(form.get('reason') ?? '').trim(),
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Signature review recorded.');
      setReviewingSigId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to review signature']);
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

    try {
      const res = await postJson(`/api/clients/${clientId}/engagement-documents/${docId}/decline`, {
        reason: String(form.get('reason') ?? '').trim(),
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Engagement document marked as declined.');
      setDecliningDocId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to decline engagement document']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="engagement-heading" className="panel mb-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 id="engagement-heading">Engagement & Authority Documents</h2>
          <p className="text-sm text-secondary">
            Versioned letters of authority, client care terms, and fee agreements. Every document includes an immutable
            SHA-256 fingerprint for integrity verification.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setOpenGenerateForm((prev) => !prev)}
            aria-expanded={openGenerateForm}
          >
            {openGenerateForm ? 'Cancel' : '+ Generate document'}
          </button>
        </div>
      </div>

      {errors && <ErrorSummary messages={errors} />}
      {statusMsg && (
        <div className="notice notice-success mb-4" role="status">
          {statusMsg}
        </div>
      )}

      {openGenerateForm && (
        <form onSubmit={handleGenerate} noValidate className="border p-4 rounded bg-gray-50 mb-6">
          <h3 className="text-base font-semibold mb-3">Tailor New Engagement Document</h3>

          <div className="field mb-3">
            <label className="label" htmlFor="templateSelect">
              Select Template
            </label>
            <select
              id="templateSelect"
              name="templateId"
              className="input"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              required
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.title} (v{tpl.version} - {TEMPLATE_KEY_NAMES[tpl.templateKey] ?? tpl.templateKey})
                </option>
              ))}
            </select>
          </div>

          <div className="field mb-3">
            <label className="label" htmlFor="matterSelect">
              Linked Matter (Optional)
            </label>
            <select id="matterSelect" name="matterId" className="input">
              <option value="">General Client Representation (No specific matter)</option>
              {matters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.reference} · {m.title}
                </option>
              ))}
            </select>
          </div>

          <div className="field mb-3">
            <label className="label" htmlFor="docTitle">
              Document Title
            </label>
            <input
              id="docTitle"
              name="title"
              className="input"
              defaultValue={activeTemplate ? `${activeTemplate.title} - ${clientName}` : 'Engagement Document'}
              required
            />
          </div>

          {activeTemplate && (
            <fieldset className="border p-3 rounded mb-4">
              <legend className="font-medium text-sm px-1">Template Merge Fields</legend>
              <p className="text-xs text-secondary mb-3">
                The allowed fields will replace all corresponding placeholder tags in the markdown template.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeTemplate.allowedFields.map((field) => {
                  let defaultVal = '';
                  if (field === 'client_name') defaultVal = clientName;
                  else if (field === 'firm_name') defaultVal = 'Apex Legal LLP';
                  else if (field === 'effective_date') defaultVal = new Date().toISOString().slice(0, 10);
                  else if (field === 'payment_terms_days') defaultVal = '14';
                  else if (field === 'billing_frequency') defaultVal = 'monthly in arrears';

                  return (
                    <div key={field} className="field">
                      <label className="label text-xs uppercase tracking-wide" htmlFor={`field_${field}`}>
                        {field.replace(/_/g, ' ')}
                      </label>
                      <input
                        id={`field_${field}`}
                        name={`field_${field}`}
                        className="input"
                        defaultValue={defaultVal}
                        placeholder={`Enter ${field.replace(/_/g, ' ')}`}
                        required
                      />
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}

          <div className="flex gap-2">
            <button className="button" type="submit" disabled={saving}>
              {saving ? 'Generating...' : 'Generate Document'}
            </button>
            <button
              className="button button-subtle"
              type="button"
              onClick={() => setOpenGenerateForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {documents.length === 0 ? (
        <p className="text-secondary py-3">No engagement documents generated for this client yet.</p>
      ) : (
        <div className="space-y-4">
          {documents.map((doc) => {
            const badge = STATE_BADGES[doc.state] ?? { label: doc.state, className: 'badge' };
            const isViewing = viewingDocId === doc.id;
            const isSigning = signingDocId === doc.id;
            const isSending = sendingDocId === doc.id;
            const isDeclining = decliningDocId === doc.id;
            const sig = doc.signature;
            const isReviewing = reviewingSigId === (sig?.id ?? null);

            return (
              <div key={doc.id} className="border rounded p-4 bg-white shadow-sm">
                <div className="flex flex-wrap justify-between items-start gap-2 mb-2">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 inline-block mr-2">
                      {doc.title}
                    </h3>
                    <span className="text-xs text-secondary mr-2">
                      ({TEMPLATE_KEY_NAMES[doc.documentKind] ?? doc.documentKind} v{doc.templateVersion})
                    </span>
                    <span className={badge.className}>{badge.label}</span>
                  </div>
                  <div className="text-xs text-secondary font-mono bg-gray-100 px-2 py-1 rounded" title="SHA-256 Digest">
                    SHA-256: {doc.contentHash.slice(0, 16)}...
                  </div>
                </div>

                <div className="text-xs text-secondary mb-3 space-y-1">
                  <div>Generated on {formatDate(doc.generatedAt)} by {doc.generatedBy.displayName}</div>
                  {doc.sentAt && (
                    <div>
                      Sent to client on {formatDate(doc.sentAt)}
                      {doc.expiresAt && ` · Valid until ${formatDate(doc.expiresAt)}`}
                    </div>
                  )}
                  {doc.viewedAt && <div>Viewed by client on {formatDate(doc.viewedAt)}</div>}
                  {doc.declinedAt && (
                    <div className="text-red-700">
                      Declined on {formatDate(doc.declinedAt)}: {doc.declineReason}
                    </div>
                  )}
                </div>

                {sig && (
                  <div className="bg-gray-50 border rounded p-3 mb-3 text-xs">
                    <div className="font-medium text-gray-800 mb-1">Recorded Signature</div>
                    <div>Signer: <strong>{sig.signerName}</strong> ({SIGNER_ROLE_LABELS[sig.signerRole] ?? sig.signerRole})</div>
                    <div>Method: {SIGNATURE_METHOD_LABELS[sig.signatureMethod] ?? sig.signatureMethod}</div>
                    <div>Signed at: {formatDate(sig.signedAt)} · Recorded by {sig.recordedBy.displayName}</div>
                    {sig.review && (
                      <div className="mt-2 pt-2 border-t border-gray-200">
                        <span className={sig.review.outcome === 'accepted' ? 'badge badge-success' : 'badge badge-danger'}>
                          Review: {sig.review.outcome.toUpperCase()}
                        </span>
                        <span className="ml-2">
                          Reviewed by {sig.review.reviewedBy.displayName} on {formatDate(sig.review.reviewedAt)}: &ldquo;{sig.review.reason}&rdquo;
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Toolbar */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
                  <button
                    type="button"
                    className="button button-subtle button-small text-xs"
                    onClick={() => setViewingDocId(isViewing ? null : doc.id)}
                  >
                    {isViewing ? 'Hide content' : 'Preview content'}
                  </button>

                  {(doc.state === 'draft' || doc.state === 'declined') && (
                    <button
                      type="button"
                      className="button button-small text-xs"
                      onClick={() => setSendingDocId(isSending ? null : doc.id)}
                    >
                      Send to client
                    </button>
                  )}

                  {(doc.state === 'sent' || doc.state === 'viewed') && (
                    <>
                      <button
                        type="button"
                        className="button button-small text-xs"
                        onClick={() => setSigningDocId(isSigning ? null : doc.id)}
                      >
                        Record wet signature / paper copy
                      </button>
                      <button
                        type="button"
                        className="button button-subtle button-small text-xs text-red-600"
                        onClick={() => setDecliningDocId(isDeclining ? null : doc.id)}
                      >
                        Decline
                      </button>
                    </>
                  )}

                  {doc.state === 'signed' && sig && !sig.review && (
                    <button
                      type="button"
                      className="button button-small text-xs"
                      onClick={() => setReviewingSigId(isReviewing ? null : sig.id)}
                    >
                      Review signature
                    </button>
                  )}
                </div>

                {/* Rendered Markdown Preview */}
                {isViewing && (
                  <div className="mt-4 p-4 border rounded bg-gray-50 text-xs">
                    <div className="flex justify-between items-center mb-2 pb-1 border-b">
                      <span className="font-semibold uppercase tracking-wider text-gray-600">Document Text Content</span>
                      <span className="font-mono text-gray-500">Hash: {doc.contentHash}</span>
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-gray-800 leading-relaxed">
                      {doc.renderedContent}
                    </pre>
                  </div>
                )}

                {/* Send Modal / Form */}
                {isSending && (
                  <form onSubmit={(e) => handleSend(e, doc.id)} className="mt-3 p-3 border rounded bg-blue-50">
                    <h4 className="font-semibold text-xs mb-2">Send Document to Client Portal</h4>
                    <div className="field mb-2">
                      <label className="label text-xs" htmlFor={`expires_${doc.id}`}>
                        Validity Duration (Days)
                      </label>
                      <input
                        id={`expires_${doc.id}`}
                        name="expiresDays"
                        type="number"
                        defaultValue={30}
                        min={1}
                        max={365}
                        className="input input-short"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className="button button-small" type="submit" disabled={saving}>
                        {saving ? 'Sending...' : 'Confirm & Send'}
                      </button>
                      <button
                        className="button button-subtle button-small"
                        type="button"
                        onClick={() => setSendingDocId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Record Wet Signature Form */}
                {isSigning && (
                  <form onSubmit={(e) => handleRecordSignature(e, doc.id)} className="mt-3 p-3 border rounded bg-amber-50">
                    <h4 className="font-semibold text-xs mb-2">Record Wet-Signature / Paper Scan</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
                      <div className="field">
                        <label className="label text-xs" htmlFor={`signerName_${doc.id}`}>
                          Signer Name
                        </label>
                        <input
                          id={`signerName_${doc.id}`}
                          name="signerName"
                          defaultValue={clientName}
                          required
                          className="input"
                        />
                      </div>
                      <div className="field">
                        <label className="label text-xs" htmlFor={`signerEmail_${doc.id}`}>
                          Signer Email (Optional)
                        </label>
                        <input id={`signerEmail_${doc.id}`} name="signerEmail" type="email" className="input" />
                      </div>
                      <div className="field">
                        <label className="label text-xs" htmlFor={`signerRole_${doc.id}`}>
                          Signer Role
                        </label>
                        <select id={`signerRole_${doc.id}`} name="signerRole" defaultValue="client" className="input">
                          <option value="client">Client</option>
                          <option value="representative">Authorised Representative</option>
                          <option value="director">Director</option>
                          <option value="officer">Officer</option>
                        </select>
                      </div>
                      <div className="field">
                        <label className="label text-xs" htmlFor={`signatureMethod_${doc.id}`}>
                          Signature Method
                        </label>
                        <select
                          id={`signatureMethod_${doc.id}`}
                          name="signatureMethod"
                          defaultValue="wet_signature_upload"
                          className="input"
                        >
                          <option value="wet_signature_upload">Wet-signature upload / Scan</option>
                          <option value="portal_drawn">Portal drawn</option>
                          <option value="provider_electronic">E-signature provider confirmation</option>
                        </select>
                      </div>
                    </div>
                    <div className="field mb-2">
                      <label className="label text-xs" htmlFor={`referenceNote_${doc.id}`}>
                        Storage reference or scanner notes
                      </label>
                      <input
                        id={`referenceNote_${doc.id}`}
                        name="referenceNote"
                        placeholder="e.g. Physical signed copy stored in file registry arch 4"
                        className="input"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className="button button-small" type="submit" disabled={saving}>
                        {saving ? 'Recording...' : 'Record Signature'}
                      </button>
                      <button
                        className="button button-subtle button-small"
                        type="button"
                        onClick={() => setSigningDocId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Decline Document Form */}
                {isDeclining && (
                  <form onSubmit={(e) => handleDecline(e, doc.id)} className="mt-3 p-3 border rounded bg-red-50">
                    <h4 className="font-semibold text-xs mb-2 text-red-800">Decline Engagement Document</h4>
                    <div className="field mb-2">
                      <label className="label text-xs" htmlFor={`declineReason_${doc.id}`}>
                        Reason for declining
                      </label>
                      <textarea
                        id={`declineReason_${doc.id}`}
                        name="reason"
                        rows={2}
                        required
                        className="input"
                        placeholder="e.g. Client requested revised terms or fee structure."
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className="button button-small bg-red-600 text-white" type="submit" disabled={saving}>
                        {saving ? 'Declining...' : 'Confirm Decline'}
                      </button>
                      <button
                        className="button button-subtle button-small"
                        type="button"
                        onClick={() => setDecliningDocId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Review Signature Form */}
                {isReviewing && sig && (
                  <form onSubmit={(e) => handleReviewSignature(e, sig.id)} className="mt-3 p-3 border rounded bg-green-50">
                    <h4 className="font-semibold text-xs mb-2 text-green-900">Review & Verify Client Signature</h4>
                    <div className="field mb-2">
                      <label className="label text-xs">Review Outcome</label>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-1 text-xs">
                          <input type="radio" name="outcome" value="accepted" defaultChecked />
                          Accept & Verify (Transitions to Active)
                        </label>
                        <label className="flex items-center gap-1 text-xs">
                          <input type="radio" name="outcome" value="rejected" />
                          Reject (Declines Document)
                        </label>
                      </div>
                    </div>
                    <div className="field mb-2">
                      <label className="label text-xs" htmlFor={`reviewReason_${sig.id}`}>
                        Review Reasoning / Identity Verification Note
                      </label>
                      <textarea
                        id={`reviewReason_${sig.id}`}
                        name="reason"
                        rows={2}
                        required
                        className="input"
                        placeholder="e.g. Signature confirmed against client passport and onboarding verification."
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className="button button-small" type="submit" disabled={saving}>
                        {saving ? 'Saving...' : 'Submit Review'}
                      </button>
                      <button
                        className="button button-subtle button-small"
                        type="button"
                        onClick={() => setReviewingSigId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
