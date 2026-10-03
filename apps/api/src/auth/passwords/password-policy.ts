import { Injectable } from '@nestjs/common';
import { BreachedPasswordChecker } from './breached-password-checker.js';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
const MIN_EMAIL_NAME_LENGTH_TO_CHECK = 4;

export type PasswordProblem = 'too_short' | 'too_long' | 'contains_email' | 'breached';

export interface PasswordPolicyResult {
  problems: PasswordProblem[];
  breachCheckSkipped: boolean;
}

/**
 * Rules for choosing a new password, following NCSC and NIST SP 800-63B:
 * length and a breached-password check, no composition rules, no expiry.
 */
@Injectable()
export class PasswordPolicy {
  constructor(private readonly breachedPasswords: BreachedPasswordChecker) {}

  async check(password: string, email: string): Promise<PasswordPolicyResult> {
    const normalised = password.normalize('NFKC');
    const length = [...normalised].length;
    const problems: PasswordProblem[] = [];

    if (length < MIN_PASSWORD_LENGTH) {
      problems.push('too_short');
    }
    if (length > MAX_PASSWORD_LENGTH) {
      problems.push('too_long');
    }
    if (containsEmailName(normalised, email)) {
      problems.push('contains_email');
    }
    if (problems.length > 0) {
      return { problems, breachCheckSkipped: false };
    }

    const breach = await this.breachedPasswords.check(normalised);
    if (breach === 'breached') {
      problems.push('breached');
    }
    return { problems, breachCheckSkipped: breach === 'unavailable' };
  }
}

function containsEmailName(password: string, email: string): boolean {
  const name = email.split('@')[0]?.toLowerCase() ?? '';
  return name.length >= MIN_EMAIL_NAME_LENGTH_TO_CHECK && password.toLowerCase().includes(name);
}
