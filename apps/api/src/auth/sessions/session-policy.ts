import type { AccountKind } from '../../database/schema.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface SessionLimits {
  idleMs: number;
  absoluteMs: number;
}

/** Decided by the project owner. See docs/authentication.md. */
export const SESSION_LIMITS: Readonly<Record<AccountKind, SessionLimits>> = {
  staff: { idleMs: 30 * MINUTE_MS, absoluteMs: 10 * HOUR_MS },
  client: { idleMs: 15 * MINUTE_MS, absoluteMs: 2 * HOUR_MS },
};

export const TWO_FACTOR_PENDING_LIFETIME_MS = 5 * MINUTE_MS;

/** Writing last_seen_at on every request would turn every read into a write. */
export const LAST_SEEN_WRITE_INTERVAL_MS = MINUTE_MS;
