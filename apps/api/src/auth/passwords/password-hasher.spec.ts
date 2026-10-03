import { describe, expect, it } from 'vitest';
import { CURRENT_PARAMETERS, MalformedPasswordHashError, PasswordHasher } from './password-hasher.js';

const hasher = new PasswordHasher();
const PASSWORD = 'correct horse battery staple';

describe('PasswordHasher', () => {
  it('produces an Argon2id PHC string with the current parameters', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  });

  it('never contains the password', async () => {
    expect(await hasher.hash(PASSWORD)).not.toContain(PASSWORD);
  });

  it('gives a different hash each time for the same password', async () => {
    expect(await hasher.hash(PASSWORD)).not.toBe(await hasher.hash(PASSWORD));
  });

  it('accepts the right password', async () => {
    const hash = await hasher.hash(PASSWORD);

    expect(await hasher.verify(PASSWORD, hash)).toBe(true);
  });

  it.each([
    ['a wrong password', 'correct horse battery stapler'],
    ['a different case', 'Correct horse battery staple'],
    ['an empty password', ''],
    ['the password with a trailing space', `${PASSWORD} `],
  ])('rejects %s', async (_case, attempt) => {
    const hash = await hasher.hash(PASSWORD);

    expect(await hasher.verify(attempt, hash)).toBe(false);
  });

  it('treats differently encoded but identical characters as the same password', async () => {
    const composed = 'café au lait please';
    const decomposed = 'café au lait please';
    const hash = await hasher.hash(composed);

    expect(await hasher.verify(decomposed, hash)).toBe(true);
  });

  describe('stored hash checks', () => {
    const valid = async () => hasher.hash(PASSWORD);

    it.each([
      ['not a PHC string', () => 'plaintext-password'],
      ['a different algorithm', async () => (await valid()).replace('$argon2id$', '$argon2i$')],
      ['an unknown version', async () => (await valid()).replace('$v=19$', '$v=16$')],
      ['excessive memory', async () => (await valid()).replace('m=19456', 'm=99999999')],
      ['excessive passes', async () => (await valid()).replace('t=2', 't=1000')],
      ['a truncated hash', async () => (await valid()).slice(0, -20)],
      ['a short salt', async () => (await valid()).replace(/\$[A-Za-z0-9+/]{22}\$/, '$AAAA$')],
    ])('refuses %s', async (_case, makeHash) => {
      await expect(hasher.verify(PASSWORD, await makeHash())).rejects.toThrow(MalformedPasswordHashError);
    });
  });

  describe('needsRehash', () => {
    it('is false for a hash made with the current parameters', async () => {
      expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
    });

    it('is true for a hash made with weaker parameters', async () => {
      const weaker = (await hasher.hash(PASSWORD)).replace(
        `m=${CURRENT_PARAMETERS.memory}`,
        `m=${CURRENT_PARAMETERS.memory / 2}`,
      );

      expect(hasher.needsRehash(weaker)).toBe(true);
    });
  });
});
