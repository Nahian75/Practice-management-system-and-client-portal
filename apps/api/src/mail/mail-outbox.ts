import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SecretBoxError } from '../common/crypto/secret-box.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { AuditMetadataValue, EmailKind } from '../database/schema.js';
import { MailCipher, type MailEnvelopeMetadata } from './mail-cipher.js';
import {
  type ClaimedEmail,
  type EmailDeliveryOutcome,
  MailOutboxRepository,
} from './mail-outbox.repository.js';
import { InvalidMailMessageError, type MailMessage, type Mailer } from './mailer.js';
import { MAILER } from './mailer.js';
import { Inject } from '@nestjs/common';

const POLL_INTERVAL_MS = 250;
const OTHER_WORKER_POLL_MS = 10;
const RETRY_SECONDS = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 6 * 60 * 60] as const;

export interface EnqueueMailOptions {
  kind: EmailKind;
  recipientAccountId?: string;
  resource?: { type: string; id: string };
  deduplicationKey?: string;
  notBefore?: Date;
  discardAfter?: Date;
  actor?: AuditActor;
  context?: RequestContext;
}

@Injectable()
export class MailOutbox implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MailOutbox.name);
  private draining: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(
    private readonly repository: MailOutboxRepository,
    private readonly cipher: MailCipher,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  async enqueue(message: MailMessage, options: EnqueueMailOptions): Promise<string> {
    const metadata = metadataFor(options);
    const sealed = this.cipher.seal(message, metadata);
    return this.repository.transaction(async (trx) => {
      const queued = await this.repository.enqueue(
        {
          ...metadata,
          deduplicationKey: options.deduplicationKey ?? null,
          ...sealed,
          notBefore: options.notBefore,
          discardAfter: options.discardAfter ?? null,
        },
        trx,
      );
      if (queued.created) {
        await this.audit.record(
          {
            actor: options.actor ?? { type: 'system' },
            action: 'email.queued',
            outcome: 'success',
            resource: { type: 'email_outbox', id: queued.id },
            metadata: safeMetadata(metadata),
            ...options.context,
          },
          trx,
        );
      }
      return queued.id;
    });
  }

  onModuleInit(): void {
    this.schedule(0);
  }

  async drain(): Promise<void> {
    const running = this.draining ?? this.processDue();
    this.draining = running;
    try {
      await running;
    } finally {
      if (this.draining === running) {
        this.draining = undefined;
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.draining;
  }

  private schedule(delay: number): void {
    if (this.stopping) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.drain()
        .catch(() => this.logger.error('Email outbox polling failed'))
        .finally(() => this.schedule(POLL_INTERVAL_MS));
    }, delay);
    this.timer.unref();
  }

  private async processDue(): Promise<void> {
    for (;;) {
      if (this.stopping) {
        return;
      }
      const message = await this.repository.claim();
      if (message) {
        await this.deliver(message);
        continue;
      }
      if (this.stopping) {
        return;
      }
      if (!(await this.repository.hasDue())) {
        return;
      }
      if (this.stopping) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OTHER_WORKER_POLL_MS));
    }
  }

  private async deliver(row: ClaimedEmail): Promise<void> {
    if (row.discardAfter && row.databaseNow >= row.discardAfter) {
      await this.complete(row, { outcome: 'discarded' });
      return;
    }
    if (row.databaseNow >= row.expiresAt) {
      await this.complete(row, { outcome: 'failed', failureClass: 'delivery_expired' });
      return;
    }

    let message: MailMessage;
    try {
      message = this.cipher.open(row, row);
    } catch (error) {
      const failureClass = error instanceof SecretBoxError ? 'invalid_payload' : 'malformed';
      await this.complete(row, { outcome: 'failed', failureClass });
      return;
    }

    try {
      await this.mailer.send(message);
      await this.complete(row, { outcome: 'sent' });
    } catch (error) {
      if (error instanceof InvalidMailMessageError) {
        await this.complete(row, { outcome: 'failed', failureClass: 'malformed' });
      } else if (isPermanentRefusal(error)) {
        await this.complete(row, { outcome: 'failed', failureClass: 'provider_rejected' });
      } else {
        const retryAfterSeconds = RETRY_SECONDS[Math.min(row.attemptCount - 1, RETRY_SECONDS.length - 1)]!;
        await this.complete(row, { outcome: 'retry', retryAfterSeconds, failureClass: 'temporary' });
        this.logger.warn(
          `Email ${row.id} (${row.kind}) will retry after attempt ${row.attemptCount}`,
        );
      }
    }
  }

  private async complete(row: ClaimedEmail, result: EmailDeliveryOutcome): Promise<void> {
    const accepted = await this.repository.transaction(async (trx) => {
      if (!(await this.repository.finish(row.id, row.leaseId, result, trx))) {
        return false;
      }
      if (result.outcome !== 'retry') {
        await this.audit.record(
          {
            actor: { type: 'system' },
            action: `email.${result.outcome}`,
            outcome: result.outcome === 'failed' ? 'failure' : 'success',
            resource: { type: 'email_outbox', id: row.id },
            metadata: safeMetadata(row),
          },
          trx,
        );
      }
      return true;
    });
    if (accepted && result.outcome !== 'retry') {
      this.logger.log(`Email ${row.id} (${row.kind}) ${result.outcome} on attempt ${row.attemptCount}`);
    }
  }
}

function metadataFor(options: EnqueueMailOptions): MailEnvelopeMetadata {
  return {
    kind: options.kind,
    recipientAccountId: options.recipientAccountId ?? null,
    resourceType: options.resource?.type ?? null,
    resourceId: options.resource?.id ?? null,
  };
}

function safeMetadata(metadata: MailEnvelopeMetadata): Record<string, AuditMetadataValue> {
  return {
    messageKind: metadata.kind,
    recipientAccountId: metadata.recipientAccountId,
    resourceType: metadata.resourceType,
    resourceId: metadata.resourceId,
  };
}

function isPermanentRefusal(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'responseCode' in error
    && typeof error.responseCode === 'number'
    && error.responseCode >= 500
  );
}
