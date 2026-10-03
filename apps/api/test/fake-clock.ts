import type { Clock } from '../src/common/time/clock.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** A clock tests can move forward, so time limits are checked without waiting. */
export class FakeClock implements Clock {
  private current = new Date();

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  reset(): void {
    this.current = new Date();
  }
}
