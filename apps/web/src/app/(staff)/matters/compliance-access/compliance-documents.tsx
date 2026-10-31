'use client';

import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { CATEGORY_LABELS, formatSize, type DocumentSummary } from '@/lib/documents';
import { isReason, REASON_MESSAGE } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * For compliance: the matter's documents, each downloaded with its own
 * reason. Every download is recorded as a separate access and the
 * supervising partner is told; the reason is cleared after each one.
 */
export function ComplianceDocuments({ documents }: { documents: DocumentSummary[] }) {
  const [errors, setErrors] = useState<string[]>();
  const [downloaded, setDownloaded] = useState<string>();
  const [sending, setSending] = useState(false);

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const chosen = documents.find((document) => document.id === fields.get('documentId'));
    const reason = String(fields.get('downloadReason') ?? '').trim();
    const problems = [...(chosen ? [] : ['Choose a document']), ...(isReason(reason) ? [] : [REASON_MESSAGE])];
    if (!chosen || problems.length > 0) {
      setErrors(problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    setDownloaded(undefined);
    try {
      const response = await postJson(
        `/api/documents/${encodeURIComponent(chosen.id)}/versions/${chosen.latest.number}/compliance-downloads`,
        { reason },
      );
      if (!response.ok) {
        setErrors(await messagesOf(response));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: chosen.latest.fileName });
      link.click();
      URL.revokeObjectURL(url);
      form.reset();
      setDownloaded(chosen.title);
    } finally {
      setSending(false);
    }
  }

  if (documents.length === 0) {
    return <p>This matter has no documents.</p>;
  }

  return (
    <form onSubmit={download} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      {downloaded && (
        <div className="notice notice-success" role="status">
          <p>Downloaded &ldquo;{downloaded}&rdquo;. The download and its reason were recorded.</p>
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="documentId">
          Document
        </label>
        <select className="input" id="documentId" name="documentId" defaultValue="">
          <option value="" disabled>
            Choose a document
          </option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.title} ({CATEGORY_LABELS[document.category]}, version {document.latest.number}, {formatSize(document.latest.sizeBytes)})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="downloadReason">
          Why you need this document
        </label>
        <span className="hint" id="downloadReason-hint">
          Needed for each download. Recorded, and the supervising partner is told.
        </span>
        <textarea className="input" id="downloadReason" name="downloadReason" rows={3} maxLength={500} aria-describedby="downloadReason-hint" />
      </div>
      <button className="button" type="submit" disabled={sending}>
        Download
      </button>
    </form>
  );
}
