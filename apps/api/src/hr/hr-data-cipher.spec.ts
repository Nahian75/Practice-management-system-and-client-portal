import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ComplianceDataCipher } from '../compliance/compliance-data-cipher.js';
import { HrDataCipher } from './hr-data-cipher.js';

describe('HrDataCipher', () => {
  it('round-trips structured personnel data without exposing plaintext', () => {
    const cipher = new HrDataCipher(testEnv());
    const sealed = cipher.seal({ personalEmail: 'private@example.test' }, 'hr-contact:person-one');

    expect(sealed.ciphertext.toString('utf8')).not.toContain('private@example.test');
    expect(cipher.open(sealed)).toEqual({ personalEmail: 'private@example.test' });
  });

  it('binds ciphertext to the person and data purpose', () => {
    const cipher = new HrDataCipher(testEnv());
    const sealed = cipher.seal({ dateOfBirth: '1990-02-03' }, 'hr-private:person-one');

    expect(() => cipher.open({ ...sealed, context: 'hr-contact:person-one' })).toThrow(/integrity check/);
    expect(() => cipher.open({ ...sealed, context: 'hr-private:person-two' })).toThrow(/integrity check/);
  });

  it('cannot open data with another HR key or the Compliance key', () => {
    const first = new HrDataCipher(testEnv());
    const other = new HrDataCipher(testEnv({ HR_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
    const sealed = first.seal({ identifier: 'protected' }, 'hr-private:person-one');

    expect(() => other.open(sealed)).toThrow(/integrity check/);
    expect(() => new ComplianceDataCipher(testEnv()).open(sealed)).toThrow(/integrity check/);
  });
});
