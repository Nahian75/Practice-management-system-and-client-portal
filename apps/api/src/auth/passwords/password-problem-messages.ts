import type { PasswordProblem } from './password-policy.js';

/** What a person is told when their chosen password is refused. */
export const PASSWORD_PROBLEM_MESSAGES: Readonly<Record<PasswordProblem, string>> = {
  too_short: 'Use at least 12 characters',
  too_long: 'Use at most 128 characters',
  contains_email: 'Do not include your email address',
  breached: 'This password has appeared in a data breach. Choose a different one',
};
