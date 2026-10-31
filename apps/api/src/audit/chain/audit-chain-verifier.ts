import { sql, type Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { CANONICAL_COLUMNS, ChainChecker, type ChainProblem } from './audit-digest.js';

const PAGE = 1000;

export interface Checkpoint {
  seq: string;
  hash: string;
}

export interface ChainReport {
  seals: number;
  head: { seq: string; hash: string } | undefined;
  problems: ChainProblem[];
  /** Emailed checkpoints the stored chain no longer matches. */
  brokenCheckpoints: Checkpoint[];
  /** Events over an hour old with no seal: written around the sealer, or after it stopped. */
  unsealed: number;
}

/** Recomputes every seal from the events as they are now, and compares the chain with the checkpoints given. */
export async function verifyAuditChain(db: Kysely<Database>, checkpoints: readonly Checkpoint[]): Promise<ChainReport> {
  const checker = new ChainChecker();
  const wanted = new Map(checkpoints.map((checkpoint) => [checkpoint.seq, checkpoint.hash.toLowerCase()]));
  const brokenCheckpoints: Checkpoint[] = [];
  let seals = 0;
  let after = '0';
  for (;;) {
    const page = await db
      .selectFrom('audit_seals')
      .leftJoin('audit_events', 'audit_events.id', 'audit_seals.event_id')
      .select(['audit_seals.seq', 'audit_seals.hash', 'audit_events.id as event_id'])
      .select(CANONICAL_COLUMNS)
      .where('audit_seals.seq', '>', after)
      .orderBy('audit_seals.seq')
      .limit(PAGE)
      .execute();
    for (const { seq, hash, event_id: eventId, ...event } of page) {
      checker.check({ seq, hash, event: eventId === null ? null : event });
      const expected = wanted.get(seq);
      if (expected !== undefined) {
        wanted.delete(seq);
        if (hash.toString('hex') !== expected) {
          brokenCheckpoints.push({ seq, hash: expected });
        }
      }
    }
    seals += page.length;
    if (page.length < PAGE) {
      break;
    }
    after = page.at(-1)?.seq ?? after;
  }
  // A checkpoint past the end of the chain means seals were removed.
  for (const [seq, hash] of wanted) {
    brokenCheckpoints.push({ seq, hash });
  }
  const { count } = await db
    .selectFrom('audit_events')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('audit_seals').select('audit_seals.seq').whereRef('audit_seals.event_id', '=', 'audit_events.id'))))
    .where('audit_events.occurred_at', '<', sql<Date>`clock_timestamp() - interval '1 hour'`)
    .executeTakeFirstOrThrow();
  return {
    seals,
    head: checker.head && { seq: checker.head.seq, hash: checker.head.hash.toString('hex') },
    problems: checker.problems,
    brokenCheckpoints,
    unsealed: Number(count),
  };
}
