'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

type Step = 'password' | 'code';

/**
 * Sign-in in two steps, as the API requires: email and password, then a code
 * from the authenticator app or a backup code. The messages shown are the
 * API's own, which never say whether an email address has an account.
 */
export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function send(path: `/api/${string}`, body: Record<string, string>) {
    setSending(true);
    setErrors(undefined);
    try {
      return await postJson(path, body);
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
    setErrors(await messagesOf(response));
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await send('/api/auth/two-factor', { code: String(form.get('code')).trim() });
    if (response.ok) {
      const { account } = (await response.json()) as { account: { kind: 'staff' | 'client' } };
      router.replace(account.kind === 'client' ? '/portal' : '/');
      router.refresh();
      return;
    }
    const messages = await messagesOf(response);
    // The waiting sign-in has ended (too many codes, or it expired): start again.
    if (messages.includes('Please sign in again')) {
      setStep('password');
    }
    setErrors(messages);
  }

  if (step === 'code') {
    return (
      <form onSubmit={submitCode} noValidate>
        {errors && <ErrorSummary messages={errors} />}
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
      {errors && <ErrorSummary messages={errors} />}
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
      <p className="after-form">
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
    </form>
  );
}
