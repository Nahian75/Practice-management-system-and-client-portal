import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentDetailsCipher } from './payment-details-cipher.js';

describe('payment details encryption', () => {
  const details = { name: 'Morgan Client', sortCode: '12-34-56', accountNumber: '12345678' };

  it('round-trips a payee without exposing it in ciphertext', () => {
    const cipher = new PaymentDetailsCipher(randomBytes(32));
    const sealed = cipher.seal(details);
    expect(cipher.open(sealed)).toEqual(details);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(details.name);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(details.accountNumber);
  });

  it('uses a new context and nonce and authenticates both', () => {
    const cipher = new PaymentDetailsCipher(randomBytes(32));
    const first = cipher.seal(details);
    const second = cipher.seal(details);
    expect(first.context).not.toBe(second.context);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(() => cipher.open({ ...first, context: second.context })).toThrow(/integrity/i);
  });

  it('fails closed with another finance key', () => {
    const sealed = new PaymentDetailsCipher(randomBytes(32)).seal(details);
    expect(() => new PaymentDetailsCipher(randomBytes(32)).open(sealed)).toThrow(/integrity/i);
  });
});
