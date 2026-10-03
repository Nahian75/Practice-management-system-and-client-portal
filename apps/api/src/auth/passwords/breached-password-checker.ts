import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';

export const FETCH = Symbol('FETCH');

const RANGE_API = 'https://api.pwnedpasswords.com/range/';
const PREFIX_LENGTH = 5;
const TIMEOUT_MS = 3_000;
const RESPONSE_LINE = /^([0-9A-F]{35}):(\d+)$/;

export type BreachCheckResult = 'breached' | 'not_breached' | 'unavailable';

/**
 * Have I Been Pwned range API, using k-anonymity: only the first five
 * characters of the password's SHA-1 hash are sent, and the comparison with
 * the returned candidates happens here. See docs/integrations.md.
 */
@Injectable()
export class BreachedPasswordChecker {
  private readonly logger = new Logger(BreachedPasswordChecker.name);

  constructor(@Inject(FETCH) private readonly fetchFn: typeof fetch) {}

  async check(password: string): Promise<BreachCheckResult> {
    const digest = createHash('sha1').update(password.normalize('NFKC'), 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, PREFIX_LENGTH);
    const suffix = digest.slice(PREFIX_LENGTH);

    let body: string;
    try {
      const response = await this.fetchFn(`${RANGE_API}${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'practice-management-api' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Breached-password check unavailable: HTTP ${response.status}`);
        return 'unavailable';
      }
      body = await response.text();
    } catch (error) {
      this.logger.warn(`Breached-password check unavailable: ${error instanceof Error ? error.name : 'unknown error'}`);
      return 'unavailable';
    }

    return isListed(body, suffix) ? 'breached' : 'not_breached';
  }
}

function isListed(body: string, suffix: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    const match = RESPONSE_LINE.exec(line.trim());
    // Padding entries have a count of 0 and are not real breaches.
    return match !== null && match[1] === suffix && Number(match[2]) > 0;
  });
}
