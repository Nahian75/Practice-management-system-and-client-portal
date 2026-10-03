import { describe, expect, it } from 'vitest';
import { hotp, matchTotp, otpauthUri, timeStep, toBase32 } from './totp.js';

// The SHA-1 secret from RFC 6238 appendix B and RFC 4226 appendix D.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('hotp', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('matches RFC 4226 test vector for counter %i', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });
});

describe('TOTP', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches RFC 6238 test vector at %i seconds', (seconds, expected) => {
    expect(hotp(RFC_SECRET, timeStep(new Date(seconds * 1000)), 8)).toBe(expected);
  });
});

describe('matchTotp', () => {
  const now = new Date(1_111_111_111_000);
  const step = timeStep(now);
  const codeAt = (s: number) => hotp(RFC_SECRET, s);

  it('accepts the current code and returns its step', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step), now, null)).toBe(step);
  });

  it('accepts one step either side for clock drift', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, codeAt(step + 1), now, null)).toBe(step + 1);
  });

  it('refuses codes two steps away', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step - 2), now, null)).toBeUndefined();
    expect(matchTotp(RFC_SECRET, codeAt(step + 2), now, null)).toBeUndefined();
  });

  it('refuses a code that was already used', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step), now, step)).toBeUndefined();
  });

  it('refuses an older code once a newer one was used', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step - 1), now, step)).toBeUndefined();
  });

  it('still accepts a newer code after an older one was used', () => {
    expect(matchTotp(RFC_SECRET, codeAt(step + 1), now, step)).toBe(step + 1);
  });

  it.each(['', '12345', '1234567', 'abcdef', ' 755224', '７５５２２４'])('refuses malformed input %j', (code) => {
    expect(matchTotp(RFC_SECRET, code, now, null)).toBeUndefined();
  });

  it('refuses a wrong code', () => {
    const wrong = String((Number(codeAt(step)) + 1) % 1_000_000).padStart(6, '0');

    expect(matchTotp(RFC_SECRET, wrong, now, null)).toBeUndefined();
  });
});

describe('toBase32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('matches RFC 4648 test vector %j', (input, expected) => {
    expect(toBase32(Buffer.from(input, 'ascii'))).toBe(expected);
  });
});

describe('otpauthUri', () => {
  it('builds the URI authenticator apps scan', () => {
    expect(otpauthUri(RFC_SECRET, 'Practice Portal', 'jane@example.com')).toBe(
      'otpauth://totp/Practice%20Portal%3Ajane%40example.com' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Practice+Portal&algorithm=SHA1&digits=6&period=30',
    );
  });
});
