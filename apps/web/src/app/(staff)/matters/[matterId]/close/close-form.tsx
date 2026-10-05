'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { isReason, REASON_MESSAGE } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

/** Closing is final: the matter, its team and its parties can no longer change. */
export function CloseForm({ matterId }: { matterId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason')).trim();
    const problems = [
      ...(isReason(reason) ? [] : [REASON_MESSAGE]),
      ...(form.get('confirm') === 'yes' ? [] : ['Confirm that closing cannot be undone']),
    ];
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson(`/api/matters/${encodeURIComponent(matterId)}/close`, { reason });
      if (response.ok) {
        router.push(`/matters/${matterId}`);
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={close} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <div className="field">
        <label className="label" htmlFor="reason">
          Why the matter is closing
        </label>
        <span className="hint" id="reason-hint">
          For example: completed, client instructions ended, or transferred to another firm.
        </span>
        <textarea className="input" id="reason" name="reason" rows={3} maxLength={500} aria-describedby="reason-hint" />
      </div>
      <div className="field checkbox">
        <label>
          <input type="checkbox" name="confirm" value="yes" />I understand a closed matter cannot be reopened or changed
        </label>
      </div>
      <button className="button button-warning" type="submit" disabled={sending}>
        Close the matter
      </button>
    </form>
  );
}
