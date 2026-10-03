import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { MailOutbox } from '../../mail/mail-outbox.js';
import { AccountsRepository } from '../accounts/accounts.repository.js';

/**
 * Emails that tell an account holder about something security-relevant, so
 * they can react if it was not them. Sent in the background: they must never
 * slow down or fail the action that triggered them.
 */
@Injectable()
export class SecurityNoticesService {
  constructor(
    private readonly accounts: AccountsRepository,
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

  private async notify(accountId: string, subject: string, lines: (name: string) => string[]): Promise<void> {
    const account = await this.accounts.findById(accountId);
    if (account) {
      this.outbox.enqueue({ to: account.email, subject, text: lines(account.display_name).join('\n') });
    }
  }
}
