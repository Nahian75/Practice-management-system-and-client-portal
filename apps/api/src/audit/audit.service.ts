import { Injectable } from '@nestjs/common';
import type { Insertable, Kysely } from 'kysely';
import type { AuditEventsTable, Database } from '../database/schema.js';
import type { AuditEvent } from './audit-event.js';
import { AuditRepository } from './audit.repository.js';

const MAX_USER_AGENT_LENGTH = 512;

@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  /**
   * Pass the caller's transaction when recording a change to data, so the
   * change and its audit entry are committed or rolled back together.
   */
  async record(event: AuditEvent, transaction?: Kysely<Database>): Promise<void> {
    await this.repository.insert(toRow(event), transaction);
  }

  /** How many units (`metadata.units`, 1 where absent) this actor used on these actions in the last `seconds`. */
  sumUnitsRecent(
    query: { actorId: string; actions: readonly string[]; seconds: number },
    transaction?: Kysely<Database>,
  ): Promise<number> {
    return this.repository.sumUnitsRecent(query, transaction);
  }

  /** How often this actor did this in the last `seconds`. Lets a limit use the audit record as its count. */
  countRecent(query: { actorId: string; action: string; seconds: number }, transaction?: Kysely<Database>): Promise<number> {
    return this.repository.countRecent(query, transaction);
  }
}

function toRow(event: AuditEvent): Insertable<AuditEventsTable> {
  return {
    actor_type: event.actor.type,
    actor_id: 'id' in event.actor ? event.actor.id : null,
    action: event.action,
    outcome: event.outcome,
    resource_type: event.resource?.type ?? null,
    resource_id: event.resource?.id ?? null,
    ip_address: event.ipAddress ?? null,
    // The user agent is supplied by the client. Truncate rather than let an
    // oversized header make the audit insert, and so the action, fail.
    user_agent: event.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    metadata: event.metadata ?? {},
  };
}
