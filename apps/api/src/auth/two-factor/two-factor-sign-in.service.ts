import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { auditActorFor, type SessionAccount } from '../sessions/authenticated-session.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SignInFailuresRepository } from '../sign-in/sign-in-failures.repository.js';
import { SignInLimits } from '../sign-in/sign-in-limits.js';
import { BackupCodesService } from './backup-codes.service.js';
import { TwoFactorService } from './two-factor.service.js';

export type TwoFactorSignInResult =
  | { outcome: 'signed_in'; token: string; account: SessionAccount }
  | { outcome: 'sign_in_again' }
  | { outcome: 'wrong_code' };

const TOTP_CODE = /^\d{6}$/;

/**
 * The second step of sign-in. Turns a session that is waiting for its 2FA code
 * into a full session, under a new token.
 */
@Injectable()
export class TwoFactorSignInService {
  constructor(
    private readonly sessions: SessionsService,
    private readonly twoFactor: TwoFactorService,
    private readonly backupCodes: BackupCodesService,
    private readonly failures: SignInFailuresRepository,
    private readonly limits: SignInLimits,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async complete(token: string | undefined, input: string, context: RequestContext): Promise<TwoFactorSignInResult> {
    const pending = await this.sessions.resolve(token);
    if (pending?.stage !== 'two_factor_pending') {
      return { outcome: 'sign_in_again' };
    }

    const { sessionId, account } = pending;
    const actor = auditActorFor(account);

    if (await this.limits.isAccountBlocked(account.id)) {
      await this.sessions.end(sessionId, 'revoked');
      await this.recordAudit(actor, 'auth.sign_in_blocked', 'denied', context, { reason: 'too_many_wrong_attempts' });
      return { outcome: 'sign_in_again' };
    }

    const code = input.trim();
    const method = TOTP_CODE.test(code) ? 'authenticator' : 'backup_code';
    const accepted =
      method === 'authenticator'
        ? await this.twoFactor.verify(account.id, code)
        : await this.backupCodes.redeem(account.id, code);

    if (!accepted) {
      await this.failures.record(
        { accountId: account.id, reason: 'wrong_two_factor_code', ipAddress: context.ipAddress, sessionId },
        this.clock.now(),
      );
      await this.recordAudit(actor, 'auth.two_factor_failed', 'denied', context, { method });
      await this.limits.afterWrongGuess(account.id);

      if (await this.limits.isSignInAttemptExhausted(sessionId)) {
        await this.sessions.end(sessionId, 'revoked');
        return { outcome: 'sign_in_again' };
      }
      return { outcome: 'wrong_code' };
    }

    await this.sessions.end(sessionId, 'replaced');
    const newToken = await this.sessions.start(account, 'authenticated', context);

    if (method === 'backup_code') {
      const remaining = await this.backupCodes.remaining(account.id);
      await this.recordAudit(actor, 'auth.backup_code_used', 'success', context, { remaining });
    }
    await this.recordAudit(actor, 'auth.sign_in_succeeded', 'success', context, { method });

    return { outcome: 'signed_in', token: newToken, account };
  }

  private recordAudit(
    actor: AuditEvent['actor'],
    action: string,
    outcome: AuditEvent['outcome'],
    context: RequestContext,
    metadata: NonNullable<AuditEvent['metadata']>,
  ): Promise<void> {
    return this.audit.record({ actor, action, outcome, metadata, ...context });
  }
}
