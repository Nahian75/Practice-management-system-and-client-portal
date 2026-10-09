'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

export function SignOffButton({ reconciliationId }: { reconciliationId: string }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [busy, setBusy] = useState(false);
  async function signOff() { setBusy(true); setErrors(undefined); try { const response = await postJson(`/api/finance/reconciliations/${reconciliationId}/sign-off`, {}); if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh(); } finally { setBusy(false); } }
  return <>{errors && <ErrorSummary messages={errors} />}<button className="button" type="button" disabled={busy} onClick={signOff}>{busy ? 'Signing off…' : 'Sign off reconciliation'}</button></>;
}
