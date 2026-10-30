import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BankAccountCipher } from './bank-account-cipher.js';

describe('bank account encryption', () => {
  const details = { sortCode: '12-34-56', accountNumber: '12345678' };

  it('preserves bank uniqueness fingerprints across encryption-key rotation',()=>{
    const original=randomBytes(32),current=randomBytes(32);
    const old=new BankAccountCipher(original).seal(details);
    const rotated=new BankAccountCipher(current,2,new Map([[1,original]]));
    expect(rotated.open(old)).toEqual(details);
    expect(rotated.seal(details).fingerprint).toEqual(old.fingerprint);
    expect(rotated.seal(details).keyVersion).toBe(2);
  });

  it('round-trips details while exposing only the last four', () => {
    const cipher = new BankAccountCipher(randomBytes(32));
    const sealed = cipher.seal(details);

    expect(cipher.open(sealed)).toEqual(details);
    expect(sealed.lastFour).toBe('5678');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('12345678');
  });

  it('uses a different nonce and context each time but a stable keyed fingerprint', () => {
    const cipher = new BankAccountCipher(randomBytes(32));
    const first = cipher.seal(details);
    const second = cipher.seal(details);

    expect(first.context).not.toBe(second.context);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.fingerprint.equals(second.fingerprint)).toBe(true);
  });

  it('binds ciphertext to its random context', () => {
    const cipher = new BankAccountCipher(randomBytes(32));
    const first = cipher.seal(details);
    const second = cipher.seal({ sortCode: '65-43-21', accountNumber: '87654321' });

    expect(() => cipher.open({ ...first, context: second.context })).toThrow(/integrity/i);
  });

  it('fails closed under a different finance key', () => {
    const first = new BankAccountCipher(randomBytes(32));
    const second = new BankAccountCipher(randomBytes(32));
    const sealed = first.seal(details);

    expect(second.seal(details).fingerprint.equals(sealed.fingerprint)).toBe(false);
    expect(() => second.open(sealed)).toThrow(/integrity/i);
  });
});
