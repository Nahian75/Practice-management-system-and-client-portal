import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';

describe('ComplianceDataCipher', () => {
  it('round-trips JSON while leaving no plaintext in PostgreSQL-shaped bytes', () => {
    const cipher = new ComplianceDataCipher(testEnv());
    const sealed = cipher.seal({ documentIdentifier: 'SECRET-123' }, 'aml-verification:one');

    expect(sealed.ciphertext.toString('utf8')).not.toContain('SECRET-123');
    expect(cipher.open(sealed)).toEqual({ documentIdentifier: 'SECRET-123' });
  });

  it('binds ciphertext to its record and purpose context', () => {
    const cipher = new ComplianceDataCipher(testEnv());
    const sealed = cipher.seal({ name: 'Protected person' }, 'aml-subject:one');

    expect(() => cipher.open({ ...sealed, context: 'aml-subject:two' })).toThrow(/integrity check/);
  });

  it('cannot open protected data under another AML key', () => {
    const first = new ComplianceDataCipher(testEnv());
    const second = new ComplianceDataCipher(testEnv({ AML_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));

    expect(() => second.open(first.seal({ name: 'Protected person' }, 'aml-subject:one'))).toThrow(/integrity check/);
  });
});
