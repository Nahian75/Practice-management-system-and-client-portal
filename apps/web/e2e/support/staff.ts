import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { E2E_AML_ENCRYPTION_KEY, E2E_FINANCE_ENCRYPTION_KEY, E2E_MAIL_ENCRYPTION_KEY, E2E_WEB_URL } from '../../playwright.config';
import { e2eDatabaseUrl } from './database.mjs';

export interface TestStaff {
  email: string;
  displayName: string;
  password: string;
  /** The authenticator app's secret, base32. */
  secret: string;
  backupCodes: string[];
}

const MAILPIT_URL = process.env['TEST_MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

/**
 * A staff member set up the way a real one is: invited from the command line,
 * then the emailed invitation accepted with a password and an authenticator
 * code. Nothing is written to the database directly.
 */
export async function createStaff(request: APIRequestContext, roles: string[] = ['fee_earner']): Promise<TestStaff> {
  const { email, displayName, token } = await inviteStaff(roles);
  const password = `quiet-harbour-${randomUUID()}`;
  const passwordStep = await request.post('/api/auth/invitations/password', { data: { token, password } });
  const { twoFactor } = (await passwordStep.json()) as { twoFactor: { secret: string } };
  const complete = await request.post('/api/auth/invitations/complete', { data: { token, code: totp(twoFactor.secret) } });
  const { backupCodes } = (await complete.json()) as { backupCodes: string[] };

  return { email, displayName, password, secret: twoFactor.secret, backupCodes };
}

/** A staff member invited from the command line, with the token from their invitation email. */
export async function inviteStaff(roles: string[] = ['fee_earner']): Promise<{ email: string; displayName: string; token: string }> {
  const id = randomUUID().slice(0, 8);
  const email = `e2e-${randomUUID()}@example.com`;
  const displayName = `E2E Staff ${id}`;

  // The command's own output is kept, to explain a missing email.
  const invited = execFileSync(
    process.execPath,
    ['../api/dist/cli/invite.js', '--kind', 'staff', '--email', email, '--name', displayName, ...roles.flatMap((role) => ['--role', role])],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: e2eDatabaseUrl(process.env['TEST_DATABASE_URL'] ?? ''),
        APP_BASE_URL: E2E_WEB_URL,
        MAIL_ENCRYPTION_KEY: E2E_MAIL_ENCRYPTION_KEY,
        FINANCE_ENCRYPTION_KEY: E2E_FINANCE_ENCRYPTION_KEY,
        AML_ENCRYPTION_KEY: E2E_AML_ENCRYPTION_KEY,
        LOG_LEVEL: 'error',
      },
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );

  return { email, displayName, token: await emailedToken(email, '/accept-invitation', invited) };
}

/** The token from a link to `path` in an email Mailpit caught for this address. */
export async function emailedToken(email: string, path: string, context = ''): Promise<string> {
  // Emails leave through the API's outbox, which falls behind when every test worker is sending at once.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = (await search.json()) as { messages: { ID: string }[] };
    // Other emails go to the same address (a role given at invitation sends one): look through them all.
    for (const message of messages) {
      const detail = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)).json()) as { Text: string };
      const token = new RegExp(`${path}#token=([A-Za-z0-9_-]{43})`).exec(detail.Text)?.[1];
      if (token) {
        return token;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No email with a ${path} link for ${email}. ${context}`);
}

/** What an authenticator app shows now (RFC 6238: SHA-1, 6 digits, 30 seconds). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

/**
 * A code for the next 30-second step. Each code works once, and accepting the
 * invitation used the current one, so a sign-in right after needs the next.
 */
export async function nextTotp(secret: string): Promise<string> {
  const now = Date.now();
  const nextStep = Math.floor(now / 30_000 + 1) * 30_000;
  await new Promise((resolve) => setTimeout(resolve, nextStep - now + 50));
  return totp(secret);
}

function fromBase32(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
