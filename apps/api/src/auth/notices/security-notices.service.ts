import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { StaffRole } from '../../database/schema.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';
import { SENSITIVE_ROLES } from '../permissions/permissions.js';
import { RolesRepository } from '../permissions/roles.repository.js';

/**
 * Emails that tell an account holder about something security-relevant, so
 * they can react if it was not them. Sent in the background: they must never
 * slow down or fail the action that triggered them.
 */
@Injectable()
export class SecurityNoticesService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly roles: RolesRepository,
    private readonly outbox: MailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async accountBlocked(accountId: string): Promise<void> {
    await this.notify(accountId, 'Sign-in to your account was blocked', (name) => [
      `Hello ${name},`,
      '',
      'Sign-in to your Practice Portal account has been blocked for 15 minutes',
      'after repeated failed attempts.',
      '',
      'If this was not you, someone may be trying to get into your account.',
      'Consider resetting your password once the block ends.',
    ]);
  }

  async passwordChanged(accountId: string): Promise<void> {
    const when = this.clock.now().toUTCString();
    await this.notify(accountId, 'Your password was changed', (name) => [
      `Hello ${name},`,
      '',
      `The password for your Practice Portal account was changed on ${when}.`,
      'Everyone signed in to your account has been signed out.',
      '',
      'If you did not do this, contact the firm immediately.',
    ]);
  }

  /**
   * Tells the person, and for a sensitive role every other compliance holder.
   * `grantedBy` is null for a grant made from the command line.
   */
  async roleGranted(accountId: string, role: StaffRole, grantedBy: string | null): Promise<void> {
    const when = this.clock.now().toUTCString();
    const by = await this.changedBy(grantedBy);
    await this.notify(accountId, 'You were given a new role', (name) => [
      `Hello ${name},`,
      '',
      `You were given the ${roleLabel(role)} role in the Practice Portal on ${when}, ${by}.`,
      '',
      'If you were not expecting this, contact the firm.',
    ]);

    if (!SENSITIVE_ROLES.includes(role)) {
      return;
    }
    const grantee = await this.accounts.findById(accountId);
    if (!grantee) {
      return;
    }
    for (const holderId of await this.roles.activeHolders('compliance')) {
      if (holderId === accountId) {
        continue;
      }
      await this.notify(holderId, `The ${roleLabel(role)} role was granted`, (name) => [
        `Hello ${name},`,
        '',
        `${grantee.display_name} (${grantee.email}) was given the ${roleLabel(role)} role`,
        `on ${when}, ${by}.`,
        '',
        'You are told because you hold the compliance role. The change is in the audit log.',
        'If it was not agreed, raise it with the firm.',
      ]);
    }
  }

  async roleRevoked(accountId: string, role: StaffRole, revokedBy: string | null): Promise<void> {
    const when = this.clock.now().toUTCString();
    const by = await this.changedBy(revokedBy);
    await this.notify(accountId, 'A role was removed from your account', (name) => [
      `Hello ${name},`,
      '',
      `The ${roleLabel(role)} role was removed from your Practice Portal account on ${when}, ${by}.`,
      '',
      'If you were not expecting this, contact the firm.',
    ]);
  }

  private async changedBy(accountId: string | null): Promise<string> {
    const account = accountId ? await this.accounts.findById(accountId) : undefined;
    return account ? `by ${account.display_name}` : 'by the system';
  }

  private async notify(accountId: string, subject: string, lines: (name: string) => string[]): Promise<void> {
    const account = await this.accounts.findById(accountId);
    if (account) {
      this.outbox.enqueue({ to: account.email, subject, text: lines(account.display_name).join('\n') });
    }
  }
}

function roleLabel(role: StaffRole): string {
  return role.replace('_', ' ');
}
