'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf } from '@/lib/requests';

export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<string[]>();

  async function markRead() {
    setSending(true);
    setErrors(undefined);
    try {
      const response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' });
      if (response.ok || response.status === 404) {
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } catch {
      setErrors(['Something went wrong. Try again']);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {errors && <ErrorSummary messages={errors} />}
      <button className="button button-secondary" type="button" disabled={sending} onClick={() => void markRead()}>
        Mark as read
      </button>
    </>
  );
}
