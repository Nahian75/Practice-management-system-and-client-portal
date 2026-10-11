import { nameTokens, normalizeName } from './sanctions-list.js';

// Proposes candidates for a person to resolve. It never decides that someone is or
// is not designated: dates of birth are recorded as agreeing or not, never used to
// dismiss a name match, because a wrong or partial date must not hide a real match.

export type BirthAgreement = 'match' | 'conflict' | 'unknown';

export interface ScreenedSubject { name: string; birth: string | null }
export interface ListName { uniqueId: string; name: string; normalized: string; tokens: string[]; births: string[] }
export interface Candidate { uniqueId: string; matchedName: string; birthAgreement: BirthAgreement }

/** The search terms for a subject: its normalized name and the words a list name must share. */
export function searchTerms(subject: ScreenedSubject): { normalized: string; tokens: string[] } {
  const normalized = normalizeName(subject.name);
  return { normalized, tokens: nameTokens(normalized) };
}

/**
 * A list name is a candidate when it equals the subject's normalized name, or when both
 * have at least two words and every word of the shorter one appears in the longer one.
 * So "Ivan Petrov" finds "Ivan Sergeyevich PETROV", but one shared word never does.
 */
export function findCandidates(subject: ScreenedSubject, names: readonly ListName[]): Candidate[] {
  const { normalized, tokens } = searchTerms(subject);
  const own = new Set(tokens);
  const found = new Map<string, Candidate>();
  for (const listName of names) {
    const shared = listName.tokens.filter((token) => own.has(token)).length;
    const contained = shared >= 2 && (shared === listName.tokens.length || shared === own.size);
    if (listName.normalized !== normalized && !contained) continue;
    const candidate = { uniqueId: listName.uniqueId, matchedName: listName.name,
      birthAgreement: birthAgreement(subject.birth, listName.births) };
    const existing = found.get(listName.uniqueId);
    if (!existing || (existing.birthAgreement !== 'match' && candidate.birthAgreement === 'match')) {
      found.set(listName.uniqueId, candidate);
    }
  }
  return [...found.values()].sort((a, b) => a.uniqueId.localeCompare(b.uniqueId));
}

/** A list birth date can be a year, a year and month, or a full date; the subject's is a full date. */
export function birthAgreement(subjectBirth: string | null, listBirths: readonly string[]): BirthAgreement {
  if (!subjectBirth || listBirths.length === 0) return 'unknown';
  return listBirths.some((birth) => subjectBirth.startsWith(birth)) ? 'match' : 'conflict';
}
