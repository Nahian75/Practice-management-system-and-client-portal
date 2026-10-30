import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, SecretBoxError } from './secret-box.js';

const box = new SecretBox(randomBytes(32), 1);
const SECRET = randomBytes(20);
const ACCOUNT = '0192a3b4-0000-7000-8000-000000000001';

describe('SecretBox', () => {
  it('reads retained versions while all new writes use the current key',()=>{
    const old=randomBytes(32),current=randomBytes(32);
    const sealed=new SecretBox(old,1).seal(SECRET,ACCOUNT);
    const rotated=new SecretBox(current,2,new Map([[1,old]]));
    expect(rotated.open(sealed,ACCOUNT)).toEqual(SECRET);
    const fresh=rotated.seal(SECRET,ACCOUNT);
    expect(fresh.keyVersion).toBe(2);
    expect(()=>new SecretBox(old,1).open(fresh,ACCOUNT)).toThrow(SecretBoxError);
    expect(()=>rotated.open(sealed,'wrong-context')).toThrow(SecretBoxError);
  });
  it('opens what it sealed', () => {
    expect(box.open(box.seal(SECRET, ACCOUNT), ACCOUNT).equals(SECRET)).toBe(true);
  });

  it('does not reveal the secret in what it stores', () => {
    const sealed = box.seal(SECRET, ACCOUNT);

    expect(sealed.ciphertext.equals(SECRET)).toBe(false);
    expect(sealed.ciphertext).toHaveLength(SECRET.length);
  });

  it('uses a fresh nonce every time', () => {
    expect(box.seal(SECRET, ACCOUNT).nonce.equals(box.seal(SECRET, ACCOUNT).nonce)).toBe(false);
  });

  it('refuses a secret moved to another account', () => {
    const sealed = box.seal(SECRET, ACCOUNT);

    expect(() => box.open(sealed, '0192a3b4-0000-7000-8000-000000000002')).toThrow(SecretBoxError);
  });

  it.each([
    ['ciphertext', 'ciphertext'],
    ['authentication tag', 'authTag'],
    ['nonce', 'nonce'],
  ] as const)('refuses a tampered %s', (_name, field) => {
    const sealed = box.seal(SECRET, ACCOUNT);
    const tampered = Buffer.from(sealed[field]);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    expect(() => box.open({ ...sealed, [field]: tampered }, ACCOUNT)).toThrow(SecretBoxError);
  });

  it('refuses a secret sealed with a different key', () => {
    const otherKey = new SecretBox(randomBytes(32), 1);

    expect(() => otherKey.open(box.seal(SECRET, ACCOUNT), ACCOUNT)).toThrow(SecretBoxError);
  });

  it('refuses a secret sealed under another key version', () => {
    const sealed = { ...box.seal(SECRET, ACCOUNT), keyVersion: 2 };

    expect(() => box.open(sealed, ACCOUNT)).toThrow(/key version 2/);
  });
});
