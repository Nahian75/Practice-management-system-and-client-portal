import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { AccountKind, SessionEndReason, SessionStage } from '../../database/schema.js';
import { auditActorFor, type ResolvedSession, type SessionAccount } from './authenticated-session.js';
import {
  LAST_SEEN_WRITE_INTERVAL_MS,
  SESSION_LIMITS,
  TWO_FACTOR_PENDING_LIFETIME_MS,
} from './session-policy.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import { SessionsRepository } from './sessions.repository.js';

const MAX_USER_AGENT_LENGTH = 512;

@Injectable()
export class SessionsService {
  constructor(
    private readonly repository: SessionsRepository,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Creates a session and returns its token. The token itself is never stored. */
  async start(
    account: { id: string; kind: AccountKind },
    stage: SessionStage,
    context: RequestContext,
  ): Promise<string> {
    const now = this.clock.now();
    const token = generateSessionToken();
    const lifetimeMs =
      stage === 'authenticated' ? SESSION_LIMITS[account.kind].absoluteMs : TWO_FACTOR_PENDING_LIFETIME_MS;

    await this.repository.insert({
      account_id: account.id,
      token_hash: hashSessionToken(token),
      stage,
      authenticated_at: stage === 'authenticated' ? now : null,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + lifetimeMs),
      ip_address: context.ipAddress ?? null,
      user_agent: context.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    });

    return token;
  }

  /**
   * Returns the open session for a token, or undefined. Checks the idle and
   * absolute limits and the account status on every call, and ends a session
   * that has run past them.
   */
  async resolve(token: string | undefined): Promise<ResolvedSession | undefined> {
    if (!token) {
      return undefined;
    }

    const row = await this.repository.findOpenByTokenHash(hashSessionToken(token));
    if (!row) {
      return undefined;
    }

    const now = this.clock.now();
    const account: SessionAccount = {
      id: row.account_id,
      kind: row.account_kind,
      displayName: row.account_display_name,
    };

    if (row.account_status !== 'active') {
      await this.repository.end(row.id, 'revoked', now);
      return undefined;
    }

    const idleLimitMs =
      row.stage === 'authenticated' ? SESSION_LIMITS[account.kind].idleMs : TWO_FACTOR_PENDING_LIFETIME_MS;
    const idleMs = now.getTime() - row.last_seen_at.getTime();

    if (now >= row.expires_at || idleMs >= idleLimitMs) {
      await this.endWithAudit(row.id, account, 'expired', 'auth.session_expired', {});
      return undefined;
    }

    if (idleMs >= LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.repository.touch(row.id, now);
    }

    return { sessionId: row.id, stage: row.stage, account };
  }

  /** Ends the session behind a token, whatever its stage. Does nothing when there is none. */
  async signOut(token: string | undefined, context: RequestContext): Promise<void> {
    const session = await this.resolve(token);
    if (session) {
      await this.endWithAudit(session.sessionId, session.account, 'signed_out', 'auth.signed_out', context);
    }
  }

  /** Ends a session. The caller records the reason in the audit log. */
  async end(sessionId: string, reason: SessionEndReason): Promise<void> {
    await this.repository.end(sessionId, reason, this.clock.now());
  }

  private async endWithAudit(
    sessionId: string,
    account: SessionAccount,
    reason: SessionEndReason,
    action: string,
    context: RequestContext,
  ): Promise<void> {
    await this.repository.end(sessionId, reason, this.clock.now());
    await this.audit.record({
      actor: auditActorFor(account),
      action,
      outcome: 'success',
      resource: { type: 'session', id: sessionId },
      ...context,
    });
  }
}
