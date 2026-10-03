import { createHash, randomInt } from 'node:crypto';

export const BACKUP_CODE_COUNT = 10;

// 16 base32 characters = 80 random bits: too many to guess online, and too
// many to brute-force from a leaked SHA-256 hash.
const CODE_LENGTH = 16;
const GROUP_LENGTH = 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const NORMALISED_PATTERN = /^[A-Z2-7]{16}$/;

/** A new code, formatted for display: `ABCD-EFGH-JKLM-NPQR`. */
export function generateBackupCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g'))!.join('-');
}

/** Accepts the code as the user might type it: any case, with or without dashes and spaces. */
export function normaliseBackupCode(input: string): string | undefined {
  const normalised = input.toUpperCase().replace(/[\s-]/g, '');
  return NORMALISED_PATTERN.test(normalised) ? normalised : undefined;
}

export function hashBackupCode(normalisedCode: string): Buffer {
  return createHash('sha256').update(normalisedCode, 'utf8').digest();
}
