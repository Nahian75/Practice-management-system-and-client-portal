import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The database stores only this hash, so a leaked table gives no working sessions. */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
