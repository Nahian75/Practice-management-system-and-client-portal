import { z } from 'zod';

// Control characters (null bytes, line breaks, tabs), line separators and
// direction overrides are refused: a null byte cannot be stored, a line break
// can split a letter or an email header later, and an override makes a name
// display as something other than what is stored. Free text must also contain
// a letter or a digit, so it cannot be made only of invisible characters.
// The database's app.is_safe_text (migration 0015) refuses the same list.
const UNSAFE_CHARACTERS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const VISIBLE_CHARACTER = /[\p{L}\p{N}]/u;

export const text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !UNSAFE_CHARACTERS.test(value), 'Contains control or text-direction characters')
    .refine((value) => VISIBLE_CHARACTER.test(value), 'Must contain a letter or a digit');
