import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/schema.js';
import { AuditService } from '../../audit/audit.service.js';

export interface EphemeralRetentionOptions {
  sessionsRetentionDays?: number;
  failuresRetentionDays?: number;
  resetsRetentionDays?: number;
  invitationsRetentionDays?: number;
  outboxRetentionDays?: number;
}

export interface EphemeralRetentionResult {
  purgedSessions: number;
  purgedSignInFailures: number;
  purgedPasswordResets: number;
  purgedInvitations: number;
  purgedEmailOutbox: number;
  totalPurged: number;
}

@Injectable()
export class SecurityRetentionService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<Database>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Purges expired and closed ephemeral authentication and security data
   * (Review F3) by executing the restricted SECURITY DEFINER function in PostgreSQL.
   */
  async purgeExpiredEphemeralData(
    options: EphemeralRetentionOptions = {},
    actorId?: string,
  ): Promise<EphemeralRetentionResult> {
    const sessionsDays = options.sessionsRetentionDays ?? 30;
    const failuresDays = options.failuresRetentionDays ?? 90;
    const resetsDays = options.resetsRetentionDays ?? 7;
    const invitationsDays = options.invitationsRetentionDays ?? 14;
    const outboxDays = options.outboxRetentionDays ?? 30;

    const result = await sql<{
      purged_sessions: number;
      purged_sign_in_failures: number;
      purged_password_resets: number;
      purged_invitations: number;
      purged_email_outbox: number;
    }>`
      SELECT * FROM app.purge_expired_ephemeral_security_data(
        ${sessionsDays}::integer,
        ${failuresDays}::integer,
        ${resetsDays}::integer,
        ${invitationsDays}::integer,
        ${outboxDays}::integer
      )
    `.execute(this.db);

    const row = result.rows[0] ?? {
      purged_sessions: 0,
      purged_sign_in_failures: 0,
      purged_password_resets: 0,
      purged_invitations: 0,
      purged_email_outbox: 0,
    };

    const purgedSessions = Number(row.purged_sessions);
    const purgedSignInFailures = Number(row.purged_sign_in_failures);
    const purgedPasswordResets = Number(row.purged_password_resets);
    const purgedInvitations = Number(row.purged_invitations);
    const purgedEmailOutbox = Number(row.purged_email_outbox);
    const totalPurged =
      purgedSessions +
      purgedSignInFailures +
      purgedPasswordResets +
      purgedInvitations +
      purgedEmailOutbox;

    await this.audit.record({
      actor: actorId ? { type: 'user', id: actorId } : { type: 'system' },
      action: 'security.ephemeral_retention_purged',
      outcome: 'success',
      metadata: {
        purgedSessions,
        purgedSignInFailures,
        purgedPasswordResets,
        purgedInvitations,
        purgedEmailOutbox,
        totalPurged,
        sessionsDays,
        failuresDays,
        resetsDays,
        invitationsDays,
        outboxDays,
      },
    });

    return {
      purgedSessions,
      purgedSignInFailures,
      purgedPasswordResets,
      purgedInvitations,
      purgedEmailOutbox,
      totalPurged,
    };
  }
}
