import { describe, expect, it } from 'vitest';
import { normaliseAddress } from './request-context.js';

describe('normaliseAddress', () => {
  it.each([
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::FFFF:198.51.100.7', '198.51.100.7'],
    ['198.51.100.7', '198.51.100.7'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['::ffff:abcd', '::ffff:abcd'],
  ])('%s becomes %s', (input, expected) => {
    expect(normaliseAddress(input)).toBe(expected);
  });
});
