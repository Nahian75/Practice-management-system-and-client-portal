'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { ReferenceAndReasonFields, referenceAndReasonFrom } from '@/components/reference-and-reason';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * For a partner: become supervising partner of a matter whose supervising
 * partner can no longer act. The API allows it only then, records the reason,
 * and tells compliance.
 */
export function TakeoverForm() {
  const [errors, setErrors] = useState<string[]>();
  const [takenOver, setTakenOver] = useState<string>();
  const [sending, setSending] = useState(false);

  async function takeOver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = referenceAndReasonFrom(new FormData(event.currentTarget));
    if ('problems' in fields) {
      setErrors(fields.problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/matter-supervision-takeovers', fields);
      if (response.ok) {
        setTakenOver(fields.matterReference.toUpperCase());
        return;
      }
      setErrors(response.status === 403 ? ['Only partners can take over supervision of a matter'] : await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  if (takenOver) {
    return (
      <div role="status">
        <p>You are now the supervising partner of {takenOver}.</p>
        <p>
          <Link href="/matters">Go to your matters</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={takeOver} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <ReferenceAndReasonFields
        reasonLabel="Reason"
        reasonHint="For example: the supervising partner has left the firm. Recorded, and compliance is told."
      />
      <button className="button" type="submit" disabled={sending}>
        Take over supervision
      </button>
    </form>
  );
}
