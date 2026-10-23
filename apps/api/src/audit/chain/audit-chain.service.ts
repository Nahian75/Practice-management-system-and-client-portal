import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { SecurityNoticesService } from '../../auth/notices/security-notices.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { CANONICAL_COLUMNS, GENESIS, sealHash } from './audit-digest.js';

const SEAL_BATCH = 500;

@Injectable()
export class AuditChainService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly notices: SecurityNoticesService,
  ) {}

  /**
   * Seals every committed event not yet sealed, oldest first, continuing
   * the chain. One sealer at a time, across API instances. Returns how many
   * were sealed.
   */
  async seal(): Promise<number> {
    let total = 0;
    for (;;) {
      const sealed = await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended('app.audit_seal', 0))`.execute(trx);
        const last = await trx
          .selectFrom('audit_seals')
          .innerJoin('audit_events', 'audit_events.id', 'audit_seals.event_id')
          .select(['audit_seals.seq', 'audit_seals.hash', 'audit_events.occurred_at'])
          .orderBy('audit_seals.seq', 'desc')
          .limit(1)
          .executeTakeFirst();
        const events = await trx
          .selectFrom('audit_events')
          .select(CANONICAL_COLUMNS)
          .where(({ not, exists, selectFrom }) =>
            not(exists(selectFrom('audit_seals').select('audit_seals.seq').whereRef('audit_seals.event_id', '=', 'audit_events.id'))),
          )
          // shortcut: an event committed over an hour after it was written is never sealed; the check script reports it as unsealed.
          .$if(last !== undefined, (query) => query.where('audit_events.occurred_at', '>=', sql<Date>`${last?.occurred_at}::timestamptz - interval '1 hour'`))
          .orderBy('audit_events.occurred_at')
          .orderBy('audit_events.id')
          .limit(SEAL_BATCH)
          .execute();
        let previous = last?.hash ?? GENESIS;
        let seq = BigInt(last?.seq ?? 0);
        const seals = events.map((event) => {
          seq += 1n;
          previous = sealHash(previous, event);
          return { seq: seq.toString(), event_id: event.id, hash: previous };
        });
        if (seals.length > 0) {
          await trx.insertInto('audit_seals').values(seals).execute();
        }
        return seals.length;
      });
      total += sealed;
      if (sealed < SEAL_BATCH) {
        return total;
      }
    }
  }

  /**
   * Seals what is waiting, then records the latest seal as this London
   * day's checkpoint and emails it to every compliance holder, in one
   * transaction. Once a day: false if the day already has its checkpoint,
   * or there is nothing sealed yet.
   */
  async checkpoint(londonDate: string): Promise<boolean> {
    await this.seal();
    return this.db.transaction().execute(async (trx) => {
      const head = await trx.selectFrom('audit_seals').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      if (!head) {
        return false;
      }
      const recorded = await trx
        .insertInto('audit_checkpoints')
        .values({ london_date: londonDate, seq: head.seq, hash: head.hash })
        .onConflict((conflict) => conflict.column('london_date').doNothing())
        .returning('seq')
        .executeTakeFirst();
      if (!recorded) {
        return false;
      }
      await this.notices.auditCheckpoint({ londonDate, seq: head.seq, hash: head.hash.toString('hex') }, trx);
      return true;
    });
  }
}
