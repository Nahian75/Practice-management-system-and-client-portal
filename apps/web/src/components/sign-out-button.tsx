'use client';

import { useState } from 'react';

/** Ends the session on the API, then goes to the sign-in page whatever the answer. */
export function SignOutButton() {
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' });
    } finally {
      window.location.assign('/sign-in');
    }
  }

  return (
    <button type="button" className="link-button" onClick={signOut} disabled={signingOut}>
      Sign out
    </button>
  );
}
