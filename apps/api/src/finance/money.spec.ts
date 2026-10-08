import { describe, expect, it } from 'vitest';
import { penceToPounds, poundsToPence } from './money.js';

describe('money strings', () => {
  it.each([
    ['0.00', '0'],
    ['12.34', '1234'],
    ['10000.00', '1000000'],
  ])('converts %s pounds to integer pence', (pounds, pence) => {
    expect(poundsToPence(pounds)).toBe(pence);
    expect(penceToPounds(pence)).toBe(pounds);
  });

  it.each(['1', '1.2', '1.234', '-1.00', '+1.00', '01.00', '10000.01', '1e2', 'NaN'])('refuses %s', (value) => {
    expect(() => poundsToPence(value)).toThrow(/money amount/i);
  });

  it('formats large database integers without converting them to floating point', () => {
    expect(penceToPounds('9007199254740993')).toBe('90071992547409.93');
  });
});
