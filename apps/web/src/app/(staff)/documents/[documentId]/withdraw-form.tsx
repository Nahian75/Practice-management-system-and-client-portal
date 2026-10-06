'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { isReason, REASON_MESSAGE } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * Withdrawing a document added by mistake. It is kept, but no longer listed
 * or downloaded, and this cannot be undone.
 */
export function WithdrawForm({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function withdraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') ?? '').trim();
    const problems = [
      ...(isReason(reason) ? [] : [REASON_MESSAGE]),
      ...(form.get('confirm') === 'yes' ? [] : ['Confirm that withdrawing cannot be undone']),
    ];
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson(`/api/documents/${encodeURIComponent(documentId)}/withdrawal`, { reason });
      if (response.ok) {
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={withdraw} noValidate>
      <h2>Withdraw this document</h2>
      <p>
        Only for a document added by mistake, such as one put on the wrong matter. It is kept, with every version, but no
        longer listed or downloaded.
      </p>
      {errors && <ErrorSummary messages={errors} />}
      <div className="field">
        <label className="label" htmlFor="reason">
          Why it is being withdrawn
        </label>
        <textarea className="input" id="reason" name="reason" rows={3} maxLength={500} />
      </div>
      <div className="field checkbox">
        <label>
          <input type="checkbox" name="confirm" value="yes" />I understand withdrawing cannot be undone
        </label>
      </div>
      <button className="button button-warning" type="submit" disabled={sending}>
        Withdraw the document
      </button>
    </form>
  );
}
