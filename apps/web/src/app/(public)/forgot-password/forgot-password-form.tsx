'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * Asks for a reset link. The answer is the same whether or not the address has
 * an account, as the API's is: the page never tells anyone who is a user.
 */
export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/auth/password-reset/request', {
        email: String(new FormData(event.currentTarget).get('email')),
      });
      if (response.ok) {
        setSent(true);
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <>
        <p>If that address has an account, we have emailed it a link to reset the password. The link works for 30 minutes.</p>
        <p>
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={request} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <p>Enter the email address you sign in with, and we will send you a link to choose a new password.</p>
      <div className="field">
        <label className="label" htmlFor="email">
          Email address
        </label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" spellCheck={false} required />
      </div>
      <button className="button" type="submit" disabled={sending}>
        Send the link
      </button>
    </form>
  );
}
