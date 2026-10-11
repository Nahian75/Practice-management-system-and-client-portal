import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';

describe('SuspicionDataCipher', () => {
  it('round-trips without plaintext and binds the purpose and record', () => {
    const cipher = new SuspicionDataCipher(testEnv());
    const sealed = cipher.seal({ facts: 'HIGHLY-RESTRICTED-FACTS' }, 'suspicion-report:one');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('HIGHLY-RESTRICTED-FACTS');
    expect(cipher.open(sealed)).toEqual({ facts: 'HIGHLY-RESTRICTED-FACTS' });
    expect(() => cipher.open({ ...sealed, context: 'suspicion-report:two' })).toThrow(/integrity check/);
  });

  it('cannot be opened with either another suspicion key or the ordinary AML key', () => {
    const first = new SuspicionDataCipher(testEnv());
    const sealed = first.seal({ facts: 'restricted' }, 'suspicion-report:one');
    const other = new SuspicionDataCipher(testEnv({ SUSPICION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
    expect(() => other.open(sealed)).toThrow(/integrity check/);
    expect(() => new ComplianceDataCipher(testEnv()).open(sealed)).toThrow(/integrity check/);
  });
});
