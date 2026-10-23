import { createHash } from 'node:crypto';
import { sql } from 'kysely';

/** The link before the first seal. */
export const GENESIS = Buffer.alloc(32);

/** An audit event as text exactly as stored, so the API and the check script hash the same bytes. */
export interface CanonicalEvent {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: string;
}

/** An event's columns as `CanonicalEvent`: the time in UTC to the microsecond, and jsonb in its normalised text. */
export const CANONICAL_COLUMNS = [
  sql<string>`audit_events.id::text`.as('id'),
  sql<string>`to_char(audit_events.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('occurred_at'),
  sql<string>`audit_events.actor_type`.as('actor_type'),
  sql<string | null>`audit_events.actor_id::text`.as('actor_id'),
  sql<string>`audit_events.action`.as('action'),
  sql<string>`audit_events.outcome`.as('outcome'),
  sql<string | null>`audit_events.resource_type`.as('resource_type'),
  sql<string | null>`audit_events.resource_id`.as('resource_id'),
  sql<string | null>`audit_events.ip_address::text`.as('ip_address'),
  sql<string | null>`audit_events.user_agent`.as('user_agent'),
  sql<string>`audit_events.metadata::text`.as('metadata'),
];

/** SHA-256 of the previous seal and the event, so changing or removing any event breaks every later seal. */
export function sealHash(previous: Buffer, event: CanonicalEvent): Buffer {
  const fields = [
    event.id,
    event.occurred_at,
    event.actor_type,
    event.actor_id,
    event.action,
    event.outcome,
    event.resource_type,
    event.resource_id,
    event.ip_address,
    event.user_agent,
    event.metadata,
  ];
  return createHash('sha256').update(previous).update(JSON.stringify(fields)).digest();
}

export interface StoredSeal {
  seq: string;
  hash: Buffer;
  /** Null when the sealed event is no longer in the log. */
  event: CanonicalEvent | null;
}

export type ChainProblem = { seq: string; problem: 'out_of_order' | 'event_missing' | 'event_changed' };

/**
 * Walks the seals in order. Each seal is checked against its own
 * predecessor as stored, so every changed event is reported, not only the first.
 */
export class ChainChecker {
  private previous: Buffer = GENESIS;
  private expected = 1n;
  readonly problems: ChainProblem[] = [];
  head: { seq: string; hash: Buffer } | undefined;

  check(seal: StoredSeal): void {
    if (BigInt(seal.seq) !== this.expected) {
      this.problems.push({ seq: seal.seq, problem: 'out_of_order' });
    }
    if (!seal.event) {
      this.problems.push({ seq: seal.seq, problem: 'event_missing' });
    } else if (!sealHash(this.previous, seal.event).equals(seal.hash)) {
      this.problems.push({ seq: seal.seq, problem: 'event_changed' });
    }
    this.previous = seal.hash;
    this.expected = BigInt(seal.seq) + 1n;
    this.head = { seq: seal.seq, hash: seal.hash };
  }
}
