'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';

type Step = 'password' | 'code';

/**
 * Sign-in in two steps, as the API requires: email and password, then a code
 * from the authenticator app or a backup code. The messages shown are the
 * API's own, which never say whether an email address has an account.
 */
export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);

  async function send(path: string, body: Record<string, string>) {
    setSending(true);
    setError(undefined);
    try {
      return await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } finally {
      setSending(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await send('/api/auth/sign-in', {
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    if (response.ok) {
      setStep('code');
      return;
    }
    setError(await messageOf(response));
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await send('/api/auth/two-factor', { code: String(form.get('code')).trim() });
    if (response.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    const message = await messageOf(response);
    // The waiting sign-in has ended (too many codes, or it expired): start again.
    if (message === 'Please sign in again') {
      setStep('password');
    }
    setError(message);
  }

  if (step === 'code') {
    return (
      <form onSubmit={submitCode} noValidate>
        {error && <ErrorSummary message={error} />}
        <div className="field">
          <label className="label" htmlFor="code">
            Security code
          </label>
          <span className="hint" id="code-hint">
            The 6-digit code from your authenticator app, or one of your backup codes.
          </span>
          <input
            className="input input-short"
            id="code"
            name="code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby="code-hint"
            required
          />
        </div>
        <button className="button" type="submit" disabled={sending}>
          Continue
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitPassword} noValidate>
      {error && <ErrorSummary message={error} />}
      <div className="field">
        <label className="label" htmlFor="email">
          Email address
        </label>
        <input className="input" id="email" name="email" type="email" autoComplete="username" spellCheck={false} required />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">
          Password
        </label>
        <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button className="button" type="submit" disabled={sending}>
        Continue
      </button>
    </form>
  );
}

/** The API's message for a refused request, or a general one if it has none. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') {
      return body.message;
    }
  } catch {
    // Not JSON: fall through to the general message.
  }
  return response.status === 429 ? 'Too many attempts. Try again later' : 'Something went wrong. Try again';
}
