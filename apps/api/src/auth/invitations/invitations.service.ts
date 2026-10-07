import { Inject, Injectable } from '@nestjs/common';
import type { AuditActor } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../common/crypto/opaque-token.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import type { AccountKind } from '../../database/schema.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';
import { PasswordHasher } from '../passwords/password-hasher.js';
import { PasswordPolicy, type PasswordProblem } from '../passwords/password-policy.js';
import { auditActorFor } from '../sessions/authenticated-session.js';
import { BackupCodesService } from '../two-factor/backup-codes.service.js';
import { TwoFactorService, type TwoFactorEnrolment } from '../two-factor/two-factor.service.js';
import { InvitationsRepository } from './invitations.repository.js';

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class AccountNotInvitableError extends Error {
  override readonly name = 'AccountNotInvitableError';
}

export interface InvitationDetails {
  email: string;
  displayName: string;
  kind: AccountKind;
}

interface OpenInvitation {
  id: string;
  account: { id: string; kind: AccountKind; email: string; displayName: string };
}

export type SetPasswordResult =
  | { outcome: 'invalid_invitation' }
  | { outcome: 'rejected'; problems: PasswordProblem[] }
  | { outcome: 'accepted'; twoFactor: TwoFactorEnrolment | null };

export type CompleteResult =
  | { outcome: 'invalid_invitation' }
  | { outcome: 'password_required' }
  | { outcome: 'wrong_code' }
  | { outcome: 'completed'; backupCodes: string[] };

/**
 * Inviting an account and accepting the invitation. The account only becomes
 * active once it has a password and confirmed 2FA, so a half-finished
 * acceptance never leaves a usable account behind.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly accounts: AccountsRepository,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly hasher: PasswordHasher,
    private readonly twoFactor: TwoFactorService,
    private readonly backupCodes: BackupCodesService,
    private readonly audit: AuditService,
    private readonly outbox: MailOutbox,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates the account if needed, replaces any earlier invitation and emails
   * the link. Refuses accounts that are already active or disabled.
   */
  async invite(
    input: { kind: AccountKind; email: string; displayName: string },
    invitedBy: { actor: AuditActor; accountId: string | null; context?: RequestContext },
  ): Promise<{ accountId: string; expiresAt: Date }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.accounts.findByEmail(email);

    if (existing && (existing.status !== 'invited' || existing.kind !== input.kind)) {
      throw new AccountNotInvitableError(`An account for ${email} already exists and cannot be invited again`);
    }

    const accountId =
      existing?.id ?? (await this.accounts.createInvited({ kind: input.kind, email, displayName: input.displayName }));
    const token = generateOpaqueToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);

    const invitationId = await this.invitations.replaceOpen({
      accountId,
      tokenHash: hashOpaqueToken(token),
      createdAt: now,
      expiresAt,
      createdBy: invitedBy.accountId,
    });

    await this.outbox.enqueue(
      {
        to: email,
        subject: 'Set up your Practice Portal account',
        text: invitationEmail(existing?.display_name ?? input.displayName, this.invitationLink(token)),
      },
      {
        kind: 'account_invitation',
        recipientAccountId: accountId,
        resource: { type: 'invitation', id: invitationId },
        deduplicationKey: `account-invitation:${invitationId}`,
        actor: invitedBy.actor,
        context: invitedBy.context,
      },
    );

    await this.audit.record({
      actor: invitedBy.actor,
      action: 'account.invited',
      outcome: 'success',
      resource: { type: 'account', id: accountId },
      metadata: { kind: input.kind },
      ...invitedBy.context,
    });

    return { accountId, expiresAt };
  }

  async inspect(token: string): Promise<InvitationDetails | undefined> {
    const invitation = await this.findOpen(token);
    return (
      invitation && {
        email: invitation.account.email,
        displayName: invitation.account.displayName,
        kind: invitation.account.kind,
      }
    );
  }

  /** Step 1 of acceptance: choose a password, then receive the 2FA secret to add to an app. */
  async setPassword(token: string, password: string): Promise<SetPasswordResult> {
    const invitation = await this.findOpen(token);
    if (!invitation) {
      return { outcome: 'invalid_invitation' };
    }

    const { account } = invitation;
    const { problems } = await this.passwordPolicy.check(password, account.email);
    if (problems.length > 0) {
      return { outcome: 'rejected', problems };
    }

    await this.accounts.setPassword(account.id, await this.hasher.hash(password), this.clock.now());

    // If 2FA was confirmed but acceptance did not finish, keep the confirmed secret.
    const twoFactor = (await this.twoFactor.isEnrolled(account.id)) ? null : await this.twoFactor.beginEnrolment(account);
    return { outcome: 'accepted', twoFactor };
  }

  /** Step 2 of acceptance: confirm 2FA with a code from the app. Activates the account. */
  async complete(token: string, code: string): Promise<CompleteResult> {
    const invitation = await this.findOpen(token);
    if (!invitation) {
      return { outcome: 'invalid_invitation' };
    }

    const { account } = invitation;
    const hasPassword = Boolean((await this.accounts.findForSignIn(account.email))?.password_hash);
    if (!hasPassword) {
      return { outcome: 'password_required' };
    }

    const codeAccepted = (await this.twoFactor.isEnrolled(account.id))
      ? await this.twoFactor.verify(account.id, code)
      : await this.twoFactor.confirmEnrolment(account, code);
    if (!codeAccepted) {
      return { outcome: 'wrong_code' };
    }

    const backupCodes = await this.backupCodes.issue(account);
    const now = this.clock.now();
    const activated = await this.invitations.transaction(async (trx) => {
      const closed = await this.invitations.close(invitation.id, now, trx);
      return closed && (await this.accounts.activate(account.id, trx));
    });
    if (!activated) {
      return { outcome: 'invalid_invitation' };
    }

    await this.audit.record({ actor: auditActorFor(account), action: 'auth.invitation_accepted', outcome: 'success' });
    return { outcome: 'completed', backupCodes };
  }

  private async findOpen(token: string): Promise<OpenInvitation | undefined> {
    const row = await this.invitations.findOpenByTokenHash(hashOpaqueToken(token));
    if (!row || row.account_status !== 'invited' || this.clock.now() >= row.expires_at) {
      return undefined;
    }
    return {
      id: row.id,
      account: {
        id: row.account_id,
        kind: row.account_kind,
        email: row.account_email,
        displayName: row.account_display_name,
      },
    };
  }

  /** The token travels in the fragment (#), which browsers never send to any server. */
  private invitationLink(token: string): string {
    const link = new URL('/accept-invitation', this.env.APP_BASE_URL);
    link.hash = `token=${token}`;
    return link.toString();
  }
}

function invitationEmail(displayName: string, link: string): string {
  return [
    `Hello ${displayName},`,
    '',
    'You have been invited to the Practice Portal. Open this link within 7 days',
    'to choose a password and set up two-factor authentication:',
    '',
    link,
    '',
    'The link works once. If you were not expecting this email, you can ignore it.',
  ].join('\n');
}
