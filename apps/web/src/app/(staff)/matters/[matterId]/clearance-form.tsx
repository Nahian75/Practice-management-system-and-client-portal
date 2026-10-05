'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { isReason, REASON_MESSAGE } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * For the supervising partner: record why the possible conflicts are not a
 * conflict, which opens the matter. The reason is kept with the check, and
 * compliance is told.
 */
export function ClearanceForm({ matterId }: { matterId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function clear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason')).trim();
    if (!isReason(reason)) {
      setErrors([REASON_MESSAGE]);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson(`/api/matters/${encodeURIComponent(matterId)}/conflict-clearance`, { reason });
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
    <form onSubmit={clear} noValidate>
      <hr className="rule" />
      <h2>Clear the possible conflicts</h2>
      <p>
        Only if you have looked at each possible conflict above and are satisfied none is a conflict. The matter then
        opens. Your reason is recorded with the check, and compliance is told.
      </p>
      {errors && <ErrorSummary messages={errors} />}
      <div className="field">
        <label className="label" htmlFor="reason">
          Why they are not a conflict
        </label>
        <textarea className="input" id="reason" name="reason" rows={4} maxLength={500} />
      </div>
      <button className="button" type="submit" disabled={sending}>
        Clear and open the matter
      </button>
    </form>
  );
}
