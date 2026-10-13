import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { SecurityRetentionService } from './security-retention.service.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { Database } from '../../database/schema.js';

class MockRetentionDriver extends DummyDriver {
  override async acquireConnection(): Promise<DatabaseConnection> {
    return {
      async executeQuery<R>() {
        return {
          rows: [
            {
              purged_sessions: 12,
              purged_sign_in_failures: 45,
              purged_password_resets: 3,
              purged_invitations: 2,
              purged_email_outbox: 8,
            } as unknown as R,
          ],
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      async *streamQuery() {},
    };
  }
}

describe('SecurityRetentionService (Step 19b, Review F3)', () => {
  let mockAudit: Partial<AuditService>;
  let db: Kysely<Database>;
  let service: SecurityRetentionService;

  beforeEach(() => {
    mockAudit = {
      record: vi.fn().mockResolvedValue(undefined),
    };

    db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new MockRetentionDriver(),
        createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });

    service = new SecurityRetentionService(db, mockAudit as AuditService);
  });

  it('purges ephemeral security data with default retention days and records audit event', async () => {
    const result = await service.purgeExpiredEphemeralData();

    expect(result.purgedSessions).toBe(12);
    expect(result.purgedSignInFailures).toBe(45);
    expect(result.purgedPasswordResets).toBe(3);
    expect(result.purgedInvitations).toBe(2);
    expect(result.purgedEmailOutbox).toBe(8);
    expect(result.totalPurged).toBe(70);

    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'system' },
        action: 'security.ephemeral_retention_purged',
        outcome: 'success',
        metadata: expect.objectContaining({
          purgedSessions: 12,
          purgedSignInFailures: 45,
          purgedPasswordResets: 3,
          purgedInvitations: 2,
          purgedEmailOutbox: 8,
          totalPurged: 70,
          sessionsDays: 30,
          failuresDays: 90,
          resetsDays: 7,
          invitationsDays: 14,
          outboxDays: 30,
        }),
      }),
    );
  });

  it('supports custom retention period options and attributes actor ID', async () => {
    const actorId = '11111111-1111-1111-1111-111111111111';
    const result = await service.purgeExpiredEphemeralData(
      {
        sessionsRetentionDays: 14,
        failuresRetentionDays: 60,
        resetsRetentionDays: 3,
        invitationsRetentionDays: 7,
        outboxRetentionDays: 15,
      },
      actorId,
    );

    expect(result.totalPurged).toBe(70);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'user', id: actorId },
        action: 'security.ephemeral_retention_purged',
        metadata: expect.objectContaining({
          sessionsDays: 14,
          failuresDays: 60,
          resetsDays: 3,
          invitationsDays: 7,
          outboxDays: 15,
        }),
      }),
    );
  });
});
