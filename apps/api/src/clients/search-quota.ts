import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Database } from '../database/schema.js';

export const SEARCHES_PER_HOUR = 60;
export const SEARCH_WINDOW_SECONDS = 60 * 60;
export const SEARCH_LIMIT_MESSAGE = 'Too many client searches or conflict checks in the last hour. Try again later';

/** Everything that looks across all clients counts towards the one hourly allowance (review C2). */
const COUNTED_ACTIONS = ['client.searched', 'matter.conflict_check_run'] as const;

/**
 * The hourly allowance for looking across every client: name searches and
 * conflict checks together. The audit records of those actions are what it
 * counts, so there is no second store to keep in step.
 */
@Injectable()
export class SearchQuota {
  constructor(private readonly audit: AuditService) {}

  /**
   * Call inside the transaction that will record the search or check. Holds a
   * per-person lock until it ends, so requests sent together cannot all pass
   * the count before any is recorded. Going over is recorded once an hour.
   */
  async allows(by: { actor: AuditActor; accountId: string; context?: RequestContext }, trx: Kysely<Database>): Promise<boolean> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`app.client_search:${by.accountId}`}, 0))`.execute(trx);
    const window = { actorId: by.accountId, seconds: SEARCH_WINDOW_SECONDS };

    let used = 0;
    for (const action of COUNTED_ACTIONS) {
      used += await this.audit.countRecent({ ...window, action }, trx);
    }
    if (used < SEARCHES_PER_HOUR) {
      return true;
    }

    if ((await this.audit.countRecent({ ...window, action: 'client.search_limited' }, trx)) === 0) {
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.search_limited',
          outcome: 'denied',
          metadata: { limit: SEARCHES_PER_HOUR },
          ...by.context,
        },
        trx,
      );
    }
    return false;
  }
}
