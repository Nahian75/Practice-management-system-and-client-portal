'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { PortalEvidenceRequest } from '@/lib/portal';
import { messagesOf } from '@/lib/requests';

export function EvidenceRequests({ requests }: { requests: PortalEvidenceRequest[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [done, setDone] = useState<string>();
  const [uploadingId, setUploadingId] = useState<string>();

  async function submitEvidence(event: FormEvent<HTMLFormElement>, requestId: string) {
    event.preventDefault();
    setErrors(undefined);
    setDone(undefined);
    setUploadingId(requestId);

    try {
      const form = new FormData(event.currentTarget);
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) {
        setErrors(['Choose a file to upload']);
        return;
      }

      const body = new FormData();
      body.append('file', file, file.name);

      const response = await fetch(`/api/portal/evidence-requests/${requestId}/submission`, {
        method: 'POST',
        body,
      });

      if (!response.ok) {
        setErrors(await messagesOf(response));
        return;
      }

      setDone(`Uploaded ${file.name} successfully.`);
      router.refresh();
    } finally {
      setUploadingId(undefined);
    }
  }

  return (
    <section aria-labelledby="evidence-requests-heading">
      <h2 id="evidence-requests-heading">Requested evidence</h2>
      <p className="secondary">
        Documents requested by your legal team for identity and compliance checks.
      </p>

      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{done && <p className="notice">{done}</p>}</div>

      {requests.length === 0 ? (
        <p>You have no outstanding evidence requests.</p>
      ) : (
        requests.map((request) => (
          <article key={request.id} className="field" aria-labelledby={`req-title-${request.id}`}>
            <h3 id={`req-title-${request.id}`}>{request.evidenceType}</h3>
            <p className="secondary">Due {formatCalendarDate(request.dueOn)}.</p>
            <p className="pre-wrap">{request.instructions}</p>

            {request.state === 'submitted' ? (
              <p className="notice">
                <strong>Submitted</strong>
                {request.submittedAt ? ` on ${formatDateTime(request.submittedAt)}` : ''}. Under review by the legal team.
              </p>
            ) : (
              <form
                aria-label={`Upload ${request.evidenceType}`}
                onSubmit={(e) => void submitEvidence(e, request.id)}
              >
                <div className="field">
                  <label className="label" htmlFor={`file-${request.id}`}>
                    Choose {request.evidenceType} file
                  </label>
                  <span className="hint" id={`hint-${request.id}`}>
                    PDF, JPEG, or PNG up to 50 MB. Checked for viruses.
                  </span>
                  <input
                    className="input"
                    id={`file-${request.id}`}
                    name="file"
                    type="file"
                    required
                    accept=".pdf,.jpeg,.jpg,.png"
                    aria-describedby={`hint-${request.id}`}
                  />
                </div>
                <button
                  className="button"
                  type="submit"
                  disabled={uploadingId === request.id}
                >
                  {uploadingId === request.id ? 'Uploading…' : `Upload ${request.evidenceType}`}
                </button>
              </form>
            )}
            <hr className="rule" />
          </article>
        ))
      )}
    </section>
  );
}
