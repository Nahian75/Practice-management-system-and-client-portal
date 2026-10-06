'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf } from '@/lib/requests';

export function SharingToggle({ documentId, shared }: { documentId: string; shared: boolean }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [done, setDone] = useState<string>();
  const [sending, setSending] = useState(false);

  async function change() {
    setSending(true);
    setErrors(undefined);
    setDone(undefined);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/client-sharing`, {
        method: shared ? 'DELETE' : 'PUT',
      });
      if (response.ok) {
        setDone(shared ? 'No longer shared with the client.' : 'Shared with the client.');
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <section>
      <h2>Client sharing</h2>
      <p>
        <strong>{shared ? 'Shared with the client' : 'Not shared with the client'}</strong>
      </p>
      <p>The client portal shows only the latest version. Earlier versions remain for the matter team only.</p>
      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{done && <p className="notice">{done}</p>}</div>
      <button className={shared ? 'button button-warning' : 'button'} type="button" disabled={sending} onClick={() => void change()}>
        {shared ? 'Stop sharing with the client' : 'Share with the client'}
      </button>
    </section>
  );
}
