'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson, takeTokenFromAddress } from '@/lib/requests';

type Stage = 'ready' | 'invalid' | 'done';

/**
 * Sets a new password from an emailed link. Everyone signed in to the account
 * is signed out by the API, and two-factor sign-in is unchanged.
 */
export function ResetPasswordForm() {
  const [token, setToken] = useState<string>();
  const [stage, setStage] = useState<Stage>('ready');
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const fromLink = takeTokenFromAddress();
    if (fromLink) {
      setToken(fromLink);
    } else {
      setStage('invalid');
    }
  }, []);

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirmation'))) {
      setErrors(['The two passwords are not the same']);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/auth/password-reset/complete', { token, password });
      if (response.ok) {
        setStage('done');
      } else if (response.status === 404) {
        setStage('invalid');
      } else {
        setErrors(await messagesOf(response));
      }
    } finally {
      setSending(false);
    }
  }

  if (stage === 'invalid') {
    return (
      <>
        <p>This reset link is invalid or has expired. Links work once, for 30 minutes.</p>
        <p>
          <Link href="/forgot-password">Ask for a new link</Link>
        </p>
      </>
    );
  }

  if (stage === 'done') {
    return (
      <>
        <p>Your password has been changed, and anyone signed in to your account has been signed out.</p>
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={reset} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <div className="field">
        <label className="label" htmlFor="password">
          New password
        </label>
        <span className="hint" id="password-hint">
          At least 12 characters. You will still need your authenticator app to sign in.
        </span>
        <input
          className="input"
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="password-hint"
          required
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="confirmation">
          Type it again
        </label>
        <input className="input" id="confirmation" name="confirmation" type="password" autoComplete="new-password" required />
      </div>
      <button className="button" type="submit" disabled={sending || !token}>
        Change password
      </button>
    </form>
  );
}
