'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { QrCode } from '@/components/qr-code';
import { messagesOf, postJson, takeTokenFromAddress } from '@/lib/requests';

type Stage =
  | { name: 'checking' }
  | { name: 'invalid'; message: string }
  | { name: 'password'; email: string; displayName: string }
  | { name: 'two_factor'; setup: { secret: string; uri: string } | null }
  | { name: 'backup_codes'; codes: string[] };

const INVALID = 'This invitation link is invalid or has expired';

/**
 * Accepting an invitation, in the order the API requires: choose a password,
 * set up the authenticator app and confirm it with a code, then keep the
 * backup codes, which are shown this once.
 */
export function AcceptInvitation() {
  const [token, setToken] = useState<string>();
  const [stage, setStage] = useState<Stage>({ name: 'checking' });
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  const [authenticatorCode, setAuthenticatorCode] = useState('');
  const setupHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (stage.name === 'two_factor') setupHeading.current?.focus();
  }, [stage.name]);

  useEffect(() => {
    const fromLink = takeTokenFromAddress();
    if (!fromLink) {
      setStage({ name: 'invalid', message: INVALID });
      return;
    }
    setToken(fromLink);
    void postJson('/api/auth/invitations/inspect', { token: fromLink }).then(async (response) => {
      if (!response.ok) {
        setStage({ name: 'invalid', message: INVALID });
        return;
      }
      const invitation = (await response.json()) as { email: string; displayName: string };
      setStage({ name: 'password', ...invitation });
    });
  }, []);

  async function send(path: `/api/${string}`, body: Record<string, string>) {
    setSending(true);
    setErrors(undefined);
    try {
      return await postJson(path, { token, ...body });
    } finally {
      setSending(false);
    }
  }

  async function choosePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirmation'))) {
      setErrors(['The two passwords are not the same']);
      return;
    }
    const response = await send('/api/auth/invitations/password', { password });
    if (response.ok) {
      const { twoFactor } = (await response.json()) as { twoFactor: { secret: string; uri: string } | null };
      setAuthenticatorCode('');
      setStage({ name: 'two_factor', setup: twoFactor });
      return;
    }
    if (response.status === 404) {
      setStage({ name: 'invalid', message: INVALID });
      return;
    }
    setErrors(await messagesOf(response));
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = authenticatorCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setErrors(['Enter the 6-digit code from your authenticator app, not your password.']);
      return;
    }
    const response = await send('/api/auth/invitations/complete', { code });
    if (response.ok) {
      const { backupCodes } = (await response.json()) as { backupCodes: string[] };
      setStage({ name: 'backup_codes', codes: backupCodes });
      return;
    }
    if (response.status === 404) {
      setStage({ name: 'invalid', message: INVALID });
      return;
    }
    setErrors(await messagesOf(response));
  }

  switch (stage.name) {
    case 'checking':
      return <p>Checking your invitation…</p>;

    case 'invalid':
      return (
        <>
          <p>{stage.message}.</p>
          <p>Ask the person who invited you to send a new invitation.</p>
        </>
      );

    case 'password':
      return (
        <form key="choose-password" onSubmit={choosePassword} noValidate>
          {errors && <ErrorSummary messages={errors} />}
          <p>
            You have been invited as <strong>{stage.displayName}</strong> ({stage.email}).
          </p>
          <div className="field">
            <label className="label" htmlFor="password">
              Choose a password
            </label>
            <span className="hint" id="password-hint">
              At least 12 characters. A few unrelated words make a strong password that is easy to remember.
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
          <button className="button" type="submit" disabled={sending}>
            Continue
          </button>
        </form>
      );

    case 'two_factor':
      return (
        <form key="confirm-authenticator" onSubmit={confirmCode} noValidate>
          {errors && <ErrorSummary messages={errors} />}
          <span className="caption">Step 2 of 3 · Secure your account</span>
          <h2 ref={setupHeading} tabIndex={-1}>Set up your authenticator app</h2>
          <p>Your password is saved. Next, connect an authenticator app to finish setting up your account.</p>
          {stage.setup ? (
            <>
              <ol className="authenticator-steps">
                <li><strong>Install an authenticator on your phone.</strong><p>If you do not have one, install Google Authenticator or Microsoft Authenticator from your phone’s app store. <a href="https://support.google.com/accounts/answer/1066447" target="_blank" rel="noreferrer">Google Authenticator setup and download help (opens a new tab)</a>.</p></li>
                <li><strong>Add your Stass account in that app.</strong><p>Open the app, choose to add an account, then scan the QR code below using the app’s scanner.</p></li>
              </ol>
              <QrCode text={stage.setup.uri} label="QR code for your authenticator app" />
              <details className="authenticator-manual"><summary>Can’t scan the QR code?</summary><p>In your authenticator app, choose manual setup or enter a setup key. Name the account “Stass”, enter this key without spaces and choose time-based codes.</p><code className="secret">{stage.setup.secret.match(/.{1,4}/g)?.join(' ')}</code><p>Keep this setup key private. It belongs in your authenticator app, not in the code box below.</p></details>
            </>
          ) : (
            <p>Open the authenticator app already connected to this account and find its current Stass code.</p>
          )}
          <div className="field authenticator-confirmation">
            <h3>Enter the app’s code here in Stass</h3>
            <label className="label" htmlFor="code">
              Code from the app
            </label>
            <span className="hint" id="code-hint">
              Enter the 6-digit number shown for Stass in your authenticator app. This is not your password and is not sent by email.
            </span>
            <input
              className="input input-short"
              id="code"
              name="authenticator-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={authenticatorCode}
              onChange={(event) => setAuthenticatorCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="000000"
              spellCheck={false}
              aria-describedby="code-hint"
              required
            />
          </div>
          <button className="button" type="submit" disabled={sending}>
            {sending ? 'Confirming…' : 'Confirm'}
          </button>
        </form>
      );

    case 'backup_codes':
      return (
        <>
          <h2>Keep your backup codes</h2>
          <p>
            If you lose your phone, each of these codes lets you sign in once instead of a code from the app. Keep
            them somewhere safe, such as a password manager. <strong>They are shown only now.</strong>
          </p>
          <ul className="backup-codes">
            {stage.codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <p>
            <Link href="/sign-in">I have kept my backup codes: sign in</Link>
          </p>
        </>
      );
  }
}
