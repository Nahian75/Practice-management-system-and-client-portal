import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { inbox, waitForEmails } from '../../test/mailpit.js';
import { InvalidMailMessageError, SmtpMailer, smtpTransportOptions } from './mailer.js';

describe('SmtpMailer', () => {
  let mailer: SmtpMailer;

  const uniqueAddress = () => `person-${randomUUID()}@example.com`;

  beforeAll(() => {
    mailer = new SmtpMailer(testEnv());
  });

  afterAll(() => {
    mailer.onApplicationShutdown();
  });

  it('delivers a plain-text email from the configured sender', async () => {
    const to = uniqueAddress();

    await mailer.send({ to, subject: 'Your invitation', text: 'Hello from the firm.' });

    expect(await waitForEmails(to)).toEqual([
      { from: 'no-reply@practice.test', to: [to], subject: 'Your invitation', text: 'Hello from the firm.\r\n' },
    ]);
  });

  it.each([
    ['a recipient with an injected header', { to: 'victim@example.com\r\nBcc: attacker@example.com' }],
    ['a subject with an injected header', { subject: 'Hello\r\nBcc: attacker@example.com' }],
    ['a subject with a bare line feed', { subject: 'Hello\nX-Injected: yes' }],
    ['a recipient that is not an email', { to: 'not-an-email' }],
    ['two recipients in one field', { to: 'one@example.com, two@example.com' }],
    ['an empty body', { text: '' }],
  ])('refuses %s and sends nothing', async (_case, override) => {
    const to = uniqueAddress();

    await expect(mailer.send({ to, subject: 'Hello', text: 'Body', ...override })).rejects.toThrow(
      InvalidMailMessageError,
    );
    expect(await inbox(to)).toEqual([]);
    expect(await inbox('attacker@example.com')).toEqual([]);
  });
});

describe('smtpTransportOptions', () => {
  it('requires TLS in production when the URL is plain smtp://', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'production', SMTP_URL: 'smtp://user:pass@smtp.example.com:587' });

    expect(options).toMatchObject({ secure: false, requireTLS: true });
  });

  it('uses implicit TLS for smtps://', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'production', SMTP_URL: 'smtps://user:pass@smtp.example.com' });

    expect(options).toMatchObject({ secure: true, port: 465 });
  });

  it('always verifies the server certificate and refuses old TLS versions', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'production', SMTP_URL: 'smtps://smtp.example.com' });

    expect(options.tls).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it('sends over a small pool of shared connections', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'production', SMTP_URL: 'smtps://smtp.example.com' });

    expect(options).toMatchObject({ pool: true, maxConnections: 3 });
  });

  it('allows a plain local mail catcher outside production', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'development', SMTP_URL: 'smtp://127.0.0.1:1025' });

    expect(options).toMatchObject({ host: '127.0.0.1', port: 1025, secure: false, requireTLS: false });
    expect(options).not.toHaveProperty('auth');
  });

  it('decodes credentials that contain URL-encoded characters', () => {
    const options = smtpTransportOptions({ NODE_ENV: 'production', SMTP_URL: 'smtps://apikey:p%40ss%2Fword@smtp.example.com' });

    expect(options.auth).toEqual({ user: 'apikey', pass: 'p@ss/word' });
  });
});
