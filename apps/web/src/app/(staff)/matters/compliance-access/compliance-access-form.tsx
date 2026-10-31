'use client';

import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { MatterDetails } from '@/components/matter-details';
import { ReferenceAndReasonFields, referenceAndReasonFrom } from '@/components/reference-and-reason';
import type { DocumentSummary } from '@/lib/documents';
import { MATTER_STATUS_LABELS, type Matter } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';
import { ComplianceDocuments } from './compliance-documents';

/**
 * For compliance: one look at a matter, with a reason. The API records each
 * look and emails the supervising partner. The matter is shown only here, in
 * this page's memory: reloading the page forgets it, and another look is
 * another record.
 */
export function ComplianceAccessForm() {
  const [errors, setErrors] = useState<string[]>();
  const [matter, setMatter] = useState<Matter & { documents: DocumentSummary[] }>();
  const [sending, setSending] = useState(false);

  async function look(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = referenceAndReasonFrom(new FormData(event.currentTarget));
    if ('problems' in fields) {
      setErrors(fields.problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/matter-compliance-accesses', fields);
      if (response.ok) {
        setMatter((await response.json()) as Matter & { documents: DocumentSummary[] });
        return;
      }
      setErrors(response.status === 403 ? ['Only compliance can look at a matter this way'] : await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  if (matter) {
    return (
      <section aria-labelledby="matter-heading">
        <span className="caption">
          {matter.reference} · {MATTER_STATUS_LABELS[matter.status]}
        </span>
        <h2 id="matter-heading">{matter.title}</h2>
        <p className="secondary">Read-only. This look has been recorded, and the supervising partner told.</p>
        <MatterDetails matter={matter} linkClient={false} />
        <h3>Documents</h3>
        <ComplianceDocuments documents={matter.documents} />
        <p>
          <button className="link-button" type="button" onClick={() => setMatter(undefined)}>
            Look at another matter
          </button>
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={look} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <ReferenceAndReasonFields
        reasonLabel="Why you need to see it"
        reasonHint="For example: complaint received, or file review. Recorded, and the supervising partner is told."
      />
      <button className="button" type="submit" disabled={sending}>
        Show the matter
      </button>
    </form>
  );
}
