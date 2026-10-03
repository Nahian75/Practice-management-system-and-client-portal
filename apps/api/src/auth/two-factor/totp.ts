import { createHmac, timingSafeEqual } from 'node:crypto';

// RFC 6238 defaults, which every authenticator app supports.
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;

/** Accept the previous and next step too, to allow for a phone clock that is slightly off. */
const ALLOWED_DRIFT_STEPS = 1;

export function timeStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** RFC 4226 HOTP, the building block of TOTP. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Returns the time step the code belongs to, or undefined if it matches none
 * within the allowed drift. Steps at or before `lastUsedStep` are refused, so
 * a code cannot be replayed.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  at: Date,
  lastUsedStep: number | null,
): number | undefined {
  if (!/^\d{6}$/.test(code)) {
    return undefined;
  }

  const current = timeStep(at);
  for (let step = current - ALLOWED_DRIFT_STEPS; step <= current + ALLOWED_DRIFT_STEPS; step += 1) {
    if (lastUsedStep !== null && step <= lastUsedStep) {
      continue;
    }
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) {
      return step;
    }
  }
  return undefined;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the format authenticator apps expect. */
export function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function otpauthUri(secret: Buffer, issuer: string, accountName: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: toBase32(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
