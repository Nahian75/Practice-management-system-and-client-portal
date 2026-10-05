'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * For a partner: become responsible for a client whose responsible person can
 * no longer see it (left the firm, or changed role). The API decides who may,
 * and records the reason.
 */
export function TakeOverForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function takeOver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson(`/api/clients/${encodeURIComponent(clientId)}/take-over`, {
        reason: String(new FormData(event.currentTarget).get('reason')).trim(),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      if (response.status === 403) {
        setErrors(['Only partners can take over a client']);
      } else if (response.status === 404) {
        setErrors(['There is no such client']);
      } else if (response.status === 400) {
        setErrors(['Give a reason of 10 to 500 characters']);
      } else {
        setErrors(await messagesOf(response));
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={takeOver} noValidate>
      <h2>Take over this client</h2>
      <p>
        A partner can become responsible for a client whose responsible person has left the firm or no longer works with
        clients. The reason is recorded, and compliance is told.
      </p>
      {errors && <ErrorSummary messages={errors} />}
      <div className="field">
        <label className="label" htmlFor="reason">
          Reason
        </label>
        <textarea className="input" id="reason" name="reason" rows={3} maxLength={500} />
      </div>
      <button className="button button-secondary" type="submit" disabled={sending}>
        Take over
      </button>
    </form>
  );
}
