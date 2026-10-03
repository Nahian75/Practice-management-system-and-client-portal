import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { SecurityNoticesService } from '../notices/security-notices.service.js';
import { SignInFailuresRepository } from './sign-in-failures.repository.js';

/** Wrong passwords and wrong 2FA codes share this limit. */
export const MAX_GUESSES = 10;
export const GUESS_WINDOW_MS = 15 * 60_000;

/** Wrong codes allowed within one sign-in attempt before it is cancelled. */
export const MAX_CODE_ATTEMPTS_PER_SIGN_IN = 5;

@Injectable()
export class SignInLimits {
  constructor(
    private readonly failures: SignInFailuresRepository,
    private readonly notices: SecurityNoticesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isAccountBlocked(accountId: string): Promise<boolean> {
    return (await this.recentGuesses(accountId)) >= MAX_GUESSES;
  }

  async isSignInAttemptExhausted(sessionId: string): Promise<boolean> {
    return (await this.failures.countForSession(sessionId)) >= MAX_CODE_ATTEMPTS_PER_SIGN_IN;
  }

  /** Call after recording a wrong password or code. Emails the account holder once, when the block starts. */
  async afterWrongGuess(accountId: string): Promise<void> {
    if ((await this.recentGuesses(accountId)) === MAX_GUESSES) {
      await this.notices.accountBlocked(accountId);
    }
  }

  private recentGuesses(accountId: string): Promise<number> {
    const windowStart = new Date(this.clock.now().getTime() - GUESS_WINDOW_MS);
    return this.failures.countGuessesSince(accountId, windowStart);
  }
}
