import type { Clock } from '../src/common/time/clock.js';
import { hotp, timeStep, TOTP_STEP_SECONDS } from '../src/auth/two-factor/totp.js';
import type { TwoFactorService } from '../src/auth/two-factor/two-factor.service.js';
import type { TestAccount } from './accounts.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** What the account's authenticator app would show at the clock's current time. */
export function authenticatorCode(secret: string, clock: Clock, stepOffset = 0): string {
  return hotp(fromBase32(secret), timeStep(clock.now()) + stepOffset);
}

/**
 * Enrols the account in 2FA and returns its secret. Leaves the clock one step
 * later, so the code used to confirm enrolment is not the next one expected.
 */
export async function enrolTwoFactor(
  twoFactor: TwoFactorService,
  account: TestAccount,
  clock: Clock & { advance(ms: number): void },
): Promise<string> {
  const { secret } = await twoFactor.beginEnrolment(account);
  if (!(await twoFactor.confirmEnrolment(account, authenticatorCode(secret, clock)))) {
    throw new Error('Test enrolment failed');
  }
  clock.advance(TOTP_STEP_SECONDS * 1000);
  return secret;
}
