import { describe, expect, it } from 'vitest';
import { generateBackupCode, hashBackupCode, normaliseBackupCode } from './backup-codes.js';

describe('generateBackupCode', () => {
  it('formats the code in four groups of four', () => {
    expect(generateBackupCode()).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it('does not repeat codes', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateBackupCode));

    expect(codes.size).toBe(1000);
  });
});

describe('normaliseBackupCode', () => {
  it.each([
    'ABCD-EFGH-JKLM-NPQR',
    'abcd-efgh-jklm-npqr',
    'ABCDEFGHJKLMNPQR',
    ' ABCD EFGH JKLM NPQR ',
    'abcd efgh-jklm npqr',
  ])('accepts %j as the same code', (input) => {
    expect(normaliseBackupCode(input)).toBe('ABCDEFGHJKLMNPQR');
  });

  it.each([
    ['too short', 'ABCD-EFGH-JKLM'],
    ['too long', 'ABCD-EFGH-JKLM-NPQR-STUV'],
    ['characters outside base32 (0, 1, 8, 9)', 'ABCD-EFGH-JKLM-NP01'],
    ['symbols', 'ABCD-EFGH-JKLM-NP!?'],
    ['a TOTP code', '123456'],
    ['empty', ''],
  ])('rejects input that is %s', (_case, input) => {
    expect(normaliseBackupCode(input)).toBeUndefined();
  });
});

describe('hashBackupCode', () => {
  it('produces a 32-byte hash that does not contain the code', () => {
    const hash = hashBackupCode('ABCDEFGHJKLMNPQR');

    expect(hash).toHaveLength(32);
    expect(hash.toString('utf8')).not.toContain('ABCDEFGHJKLMNPQR');
  });
});
