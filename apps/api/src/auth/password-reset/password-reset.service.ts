import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';
import { SecurityNoticesService } from '../notices/security-notices.service.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { PasswordPolicy, type PasswordProblem } from '../passwords/password-policy.js';
import { auditActorFor } from '../sessions/authenticated-session.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { PasswordResetsRepository } from './password-resets.repository.js';

export const RESET_LIFETIME_MS = 30 * 60_000;
export const MAX_RESETS_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export type CompleteResetResult =
  | { outcome: 'invalid_link' }
  | { outcome: 'rejected'; problems: PasswordProblem[] }
  | { outcome: 'completed' };

/**
 * Password reset by emailed link. Resetting the password does not touch 2FA:
 * someone who has taken over the email inbox still cannot sign in.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly resets: PasswordResetsRepository,
    private readonly accounts: AccountsRepository,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionsService,
    private readonly notices: SecurityNoticesService,
    private readonly outbox: MailOutbox,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Emails a reset link to an active account. Returns nothing either way, and
   * the email is sent in the background, so neither the answer nor its timing
   * reveals whether the address has an account.
   */
  async request(email: string, context: RequestContext): Promise<void> {
    const account = await this.accounts.findByEmail(email.trim().toLowerCase());
    const now = this.clock.now();

    if (account?.status !== 'active') {
      await this.audit.record({
        actor: { type: 'anonymous' },
        action: 'auth.password_reset_requested',
        outcome: 'denied',
        metadata: { reason: account ? 'account_not_active' : 'unknown_account' },
        ...context,
      });
      return;
    }

    const actor = auditActorFor(account);
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    if ((await this.resets.countRequestedSince(account.id, hourAgo)) >= MAX_RESETS_PER_HOUR) {
      await this.audit.record({
        actor,
        action: 'auth.password_reset_requested',
        outcome: 'denied',
        metadata: { reason: 'too_many_requests' },
        ...context,
      });
      return;
    }

    const token = generateOpaqueToken();
    const resetId = await this.resets.replaceOpen({
      accountId: account.id,
      tokenHash: hashOpaqueToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + RESET_LIFETIME_MS),
      requestedIp: context.ipAddress,
    });

    await this.outbox.enqueue(
      {
        to: account.email,
        subject: 'Reset your Practice Portal password',
        text: resetEmail(account.display_name, this.resetLink(token)),
      },
      {
        kind: 'password_reset',
        recipientAccountId: account.id,
        resource: { type: 'password_reset', id: resetId },
        deduplicationKey: `password-reset:${resetId}`,
        discardAfter: new Date(now.getTime() + RESET_LIFETIME_MS),
        actor,
        context,
      },
    );
    await this.audit.record({ actor, action: 'auth.password_reset_requested', outcome: 'success', ...context });
  }

  async complete(token: string, password: string, context: RequestContext): Promise<CompleteResetResult> {
    const reset = await this.resets.findOpenByTokenHash(hashOpaqueToken(token));
    const now = this.clock.now();
    if (!reset || reset.account_status !== 'active' || now >= reset.expires_at) {
      return { outcome: 'invalid_link' };
    }

    const { problems } = await this.passwordPolicy.check(password, reset.account_email);
    if (problems.length > 0) {
      return { outcome: 'rejected', problems };
    }

    // Close first: if two requests race with the same link, only one goes on.
    if (!(await this.resets.close(reset.id, now))) {
      return { outcome: 'invalid_link' };
    }

    await this.accounts.setPassword(reset.account_id, await this.hasher.hash(password), now);
    const endedSessions = await this.sessions.endAllForAccount(reset.account_id, 'revoked');

    await this.audit.record({
      actor: auditActorFor({ id: reset.account_id, kind: reset.account_kind }),
      action: 'auth.password_reset_completed',
      outcome: 'success',
      metadata: { endedSessions },
      ...context,
    });
    await this.notices.passwordChanged(reset.account_id);

    return { outcome: 'completed' };
  }

  /** The token travels in the fragment (#), which browsers never send to any server. */
  private resetLink(token: string): string {
    const link = new URL('/reset-password', this.env.APP_BASE_URL);
    link.hash = `token=${token}`;
    return link.toString();
  }
}

function resetEmail(displayName: string, link: string): string {
  return [
    `Hello ${displayName},`,
    '',
    'Someone asked to reset the password for your Practice Portal account.',
    'If it was you, open this link within 30 minutes:',
    '',
    link,
    '',
    'You will still need your authenticator app to sign in afterwards.',
    '',
    'If you did not ask for this, ignore this email. Your password has not changed.',
  ].join('\n');
}
