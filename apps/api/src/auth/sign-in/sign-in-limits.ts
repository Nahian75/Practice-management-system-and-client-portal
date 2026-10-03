import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/time/clock.js';
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isAccountBlocked(accountId: string): Promise<boolean> {
    const windowStart = new Date(this.clock.now().getTime() - GUESS_WINDOW_MS);
    return (await this.failures.countGuessesSince(accountId, windowStart)) >= MAX_GUESSES;
  }

  async isSignInAttemptExhausted(sessionId: string): Promise<boolean> {
    return (await this.failures.countForSession(sessionId)) >= MAX_CODE_ATTEMPTS_PER_SIGN_IN;
  }
}
