import { randomBytes } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { AuditEvent } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { auditActorFor } from '../sessions/authenticated-session.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TwoFactorService } from '../two-factor/two-factor.service.js';
import { SignInFailuresRepository } from './sign-in-failures.repository.js';
import { SignInLimits } from './sign-in-limits.js';

export type SignInResult =
  | { outcome: 'two_factor_required'; token: string }
  | { outcome: 'rejected' }
  | { outcome: 'rate_limited' };

const REJECTED: SignInResult = { outcome: 'rejected' };

/**
 * The password step of sign-in. Every rejection looks the same to the caller,
 * and costs the same password-hashing work, so neither the answer nor its
 * timing reveals whether an email has an account.
 */
@Injectable()
export class SignInService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly failures: SignInFailuresRepository,
    private readonly limits: SignInLimits,
    private readonly hasher: PasswordHasher,
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hasher.hash(randomBytes(32).toString('base64url'));
  }

  async signIn(email: string, password: string, context: RequestContext): Promise<SignInResult> {
    if (await this.limits.isAddressBlocked(context.ipAddress)) {
      await this.recordAudit({ type: 'anonymous' }, 'auth.sign_in_rate_limited', 'denied', context, 'too_many_failures_from_address');
      return { outcome: 'rate_limited' };
    }

    const account = await this.accounts.findForSignIn(email.trim().toLowerCase());
    const now = this.clock.now();

    if (!account?.password_hash) {
      await this.hasher.verify(password, this.dummyHash);
      await this.failures.record({ accountId: null, reason: 'unknown_account', ipAddress: context.ipAddress }, now);
      await this.recordAudit({ type: 'anonymous' }, 'auth.sign_in_failed', 'denied', context, 'unknown_account');
      return REJECTED;
    }

    const actor = auditActorFor(account);

    if (await this.limits.isAccountBlocked(account.id)) {
      await this.hasher.verify(password, this.dummyHash);
      await this.recordAudit(actor, 'auth.sign_in_blocked', 'denied', context, 'too_many_wrong_attempts');
      return REJECTED;
    }

    if (!(await this.hasher.verify(password, account.password_hash))) {
      await this.failures.record({ accountId: account.id, reason: 'wrong_password', ipAddress: context.ipAddress }, now);
      await this.recordAudit(actor, 'auth.sign_in_failed', 'denied', context, 'wrong_password');
      await this.limits.afterWrongGuess(account.id);
      return REJECTED;
    }

    // Checked only after the password, so a guesser cannot learn which
    // accounts are disabled or not yet set up.
    if (account.status !== 'active') {
      await this.failures.record({ accountId: account.id, reason: 'account_not_active', ipAddress: context.ipAddress }, now);
      await this.recordAudit(actor, 'auth.sign_in_failed', 'denied', context, 'account_not_active');
      return REJECTED;
    }
    if (!(await this.twoFactor.isEnrolled(account.id))) {
      await this.recordAudit(actor, 'auth.sign_in_failed', 'denied', context, 'two_factor_not_enrolled');
      return REJECTED;
    }

    if (this.hasher.needsRehash(account.password_hash)) {
      await this.accounts.replacePasswordHash(account.id, await this.hasher.hash(password));
    }

    const token = await this.sessions.start(account, 'two_factor_pending', context);
    await this.recordAudit(actor, 'auth.password_accepted', 'success', context);
    return { outcome: 'two_factor_required', token };
  }

  private recordAudit(
    actor: AuditEvent['actor'],
    action: string,
    outcome: AuditEvent['outcome'],
    context: RequestContext,
    reason?: string,
  ): Promise<void> {
    return this.audit.record({ actor, action, outcome, ...context, ...(reason ? { metadata: { reason } } : {}) });
  }
}
