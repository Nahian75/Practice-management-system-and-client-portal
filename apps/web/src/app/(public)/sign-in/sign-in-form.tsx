'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { messagesOf, postJson } from '@/lib/requests';

type Step = 'password' | 'code';

/** Both steps use the existing authentication API and retain its neutral error messages. */
export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === 'code') codeInput.current?.focus(); }, [step]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const data = new FormData(event.currentTarget);
    setSending(true);
    setErrors(undefined);
    try {
      const response = step === 'password'
        ? await postJson('/api/auth/sign-in', { email: String(data.get('email')).trim(), password: String(data.get('password')) })
        : await postJson('/api/auth/two-factor', { code: String(data.get('code')).trim() });
      if (!response.ok) {
        const messages = await messagesOf(response);
        if (messages.includes('Please sign in again')) setStep('password');
        setErrors(messages);
        return;
      }
      if (step === 'password') {
        setShowPassword(false);
        setStep('code');
        return;
      }
      const { account } = (await response.json()) as { account: { kind: 'staff' | 'client' } };
      router.replace(account.kind === 'client' ? '/portal' : '/');
      router.refresh();
    } catch {
      setErrors(['We could not connect. Check your connection and try again.']);
    } finally {
      setSending(false);
    }
  }

  return <div className="sign-in-auth">
    <div className="sign-in-step-label" role="status">{step === 'password' ? '01 / Account details' : '02 / Security verification'}</div>
    <h1>{step === 'password' ? 'Sign in to your account' : 'Verify it’s you'}</h1>
    <p className="sign-in-description">{step === 'password' ? 'Welcome back. Enter your details to continue to your workspace.' : 'Enter a code from your authenticator app to finish signing in.'}</p>
    <form key={step} onSubmit={submit} aria-label={step === 'password' ? 'Account sign-in' : 'Security verification'} aria-busy={sending}>
      {errors && <ErrorSummary messages={errors} />}
      {step === 'password' ? <>
        <div className="field"><label className="label" htmlFor="email">Email address</label><input className="input" id="email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@yourpractice.com" required disabled={sending} /></div>
        <div className="field"><div className="sign-in-label-row"><label className="label" htmlFor="password">Password</label><Link href="/forgot-password">Forgot password?</Link></div>
          <div className="sign-in-password"><input className="input" id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required disabled={sending} />
            <button type="button" className="sign-in-password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} aria-controls="password" onClick={() => setShowPassword(!showPassword)} disabled={sending}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{showPassword && <path d="m3 3 18 18" />}</svg>
            </button>
          </div>
        </div>
      </> : <div className="field"><label className="label" htmlFor="code">Security code</label><p className="hint" id="code-hint">Use the 6-digit code from your authenticator, or a saved backup code.</p><input ref={codeInput} className="input sign-in-code" id="code" name="code" type="text" inputMode="text" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} aria-describedby="code-hint" required disabled={sending} /></div>}
      <button className="button sign-in-submit" type="submit" disabled={sending}>{sending ? <><span className="sign-in-spinner" aria-hidden="true" />{step === 'password' ? 'Checking your details…' : 'Verifying your code…'}</> : <>{step === 'password' ? 'Continue' : 'Verify and sign in'}<span aria-hidden="true">→</span></>}</button>
      <p className="sign-in-security-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></svg>{step === 'password' ? 'Your authenticator code is checked in the next step.' : 'Keep your security codes private.'}</p>
    </form>
  </div>;
}
