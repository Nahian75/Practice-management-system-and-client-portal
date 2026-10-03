import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { MAILER, type MailMessage, type Mailer } from './mailer.js';

/**
 * Sends email without making the caller wait. Used where the time taken to
 * send would otherwise reveal something, such as whether an email address
 * has an account. Failures are logged, never the message: bodies can carry
 * one-time links.
 *
 * Messages still in flight are awaited at shutdown. A crash can still lose
 * one; a persistent queue replaces this before production.
 */
@Injectable()
export class MailOutbox implements OnApplicationShutdown {
  private readonly logger = new Logger(MailOutbox.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  enqueue(message: MailMessage): void {
    const sending = this.mailer
      .send(message)
      .catch((error: unknown) => {
        this.logger.error(`Email could not be sent: ${error instanceof Error ? error.name : 'unknown error'}`);
      })
      .finally(() => this.inFlight.delete(sending));
    this.inFlight.add(sending);
  }

  /** Resolves once every email queued so far has been handed to the mail server, or has failed. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all(this.inFlight);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }
}
