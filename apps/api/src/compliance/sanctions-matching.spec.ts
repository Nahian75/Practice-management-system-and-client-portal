import { describe, expect, it } from 'vitest';
import { nameTokens, normalizeName } from './sanctions-list.js';
import { birthAgreement, findCandidates, type ListName } from './sanctions-matching.js';

const listName = (uniqueId: string, name: string, births: string[] = []): ListName => {
  const normalized = normalizeName(name);
  return { uniqueId, name, normalized, tokens: nameTokens(normalized), births };
};

describe('findCandidates', () => {
  const names = [
    listName('RUS0001', 'Ivan Sergeyevich PETROV', ['1961-03-12']),
    listName('RUS0002', 'Ivan IVANOV'),
    listName('ENT0001', 'ROSNEFT'),
    listName('RUS0001', 'Ivan PETROV', ['1961-03-12']),
  ];

  it('finds names that contain each other with at least two shared words', () => {
    expect(findCandidates({ name: 'Ivan Petrov', birth: null }, names)).toEqual([
      { uniqueId: 'RUS0001', matchedName: 'Ivan Sergeyevich PETROV', birthAgreement: 'unknown' },
    ]);
    expect(findCandidates({ name: 'Ivan Sergeyevich Petrov Junior', birth: null }, names).map((c) => c.uniqueId)).toEqual(['RUS0001']);
  });

  it('never matches on one shared word, but matches an exact single-word name', () => {
    expect(findCandidates({ name: 'Ivan Smith', birth: null }, names)).toEqual([]);
    expect(findCandidates({ name: 'Rosneft', birth: null }, names).map((c) => c.uniqueId)).toEqual(['ENT0001']);
    expect(findCandidates({ name: 'Rosneft Trading', birth: null }, names)).toEqual([]);
  });

  it('ignores accents, case and punctuation, and records birth agreement without dismissing', () => {
    expect(findCandidates({ name: 'IVÁN petrov', birth: '1961-03-12' }, names)[0]!.birthAgreement).toBe('match');
    expect(findCandidates({ name: 'Ivan Petrov', birth: '1990-01-01' }, names)).toEqual([
      expect.objectContaining({ uniqueId: 'RUS0001', birthAgreement: 'conflict' }),
    ]);
  });
});

describe('birthAgreement', () => {
  it('compares a full date with a year, a year and month, or a full date', () => {
    expect(birthAgreement('1961-03-12', ['1961'])).toBe('match');
    expect(birthAgreement('1961-03-12', ['1961-03'])).toBe('match');
    expect(birthAgreement('1961-03-12', ['1960', '1962-01-01'])).toBe('conflict');
    expect(birthAgreement(null, ['1961'])).toBe('unknown');
    expect(birthAgreement('1961-03-12', [])).toBe('unknown');
  });
});
