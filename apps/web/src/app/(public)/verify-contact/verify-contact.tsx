'use client';

import { useEffect, useState } from 'react';
import { postJson, takeTokenFromAddress } from '@/lib/requests';

type State = 'checking' | 'verified' | 'invalid';

export function VerifyContact() {
  const [state, setState] = useState<State>('checking');
  useEffect(() => {
    const token = takeTokenFromAddress();
    if (!token) { setState('invalid'); return; }
    void postJson('/api/contact-verifications/complete', { token })
      .then((response) => setState(response.ok ? 'verified' : 'invalid'))
      .catch(() => setState('invalid'));
  }, []);

  if (state === 'checking') return <p>Checking the one-time link…</p>;
  if (state === 'invalid') return <><p>This verification link is invalid, expired, replaced, or already used.</p>
    <p>Please ask the firm to send a new link. Do not forward the old link.</p></>;
  return <div className="notice"><p><strong>Email address verified.</strong></p>
    <p>This confirms control of this email channel only. It does not verify identity or complete the firm&apos;s legal, conflict, or AML checks.</p></div>;
}
