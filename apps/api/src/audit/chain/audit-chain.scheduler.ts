import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { londonReminderSchedule } from '../../notifications/notification-schedule.js';
import { AuditChainService } from './audit-chain.service.js';

const SEAL_EVERY_MS = 60_000;

/** Seals new audit events every minute, and sends the checkpoint at 09:00 London each day. */
@Injectable()
export class AuditChainScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuditChainScheduler.name);
  private sealTimer: NodeJS.Timeout | undefined;
  private checkpointTimer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly chain: AuditChainService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') {
      return;
    }
    this.sealTimer = setInterval(() => this.queue(() => this.chain.seal(), 'Audit sealing failed'), SEAL_EVERY_MS);
    this.sealTimer.unref();
    this.scheduleCheckpoint();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.sealTimer);
    clearTimeout(this.checkpointTimer);
    this.sealTimer = undefined;
    this.checkpointTimer = undefined;
    await this.running;
  }

  /** Runs after 09:00 London: straight away if already past it today (once a day is kept by the database), else at 09:00. */
  private scheduleCheckpoint(): void {
    const schedule = londonReminderSchedule(this.clock.now());
    if (schedule.runNow) {
      this.queue(() => this.chain.checkpoint(schedule.londonDate), 'Audit checkpoint failed');
    }
    const delay = Math.max(0, schedule.nextRunAt.getTime() - this.clock.now().getTime());
    this.checkpointTimer = setTimeout(() => {
      if (this.sealTimer) {
        this.scheduleCheckpoint();
      }
    }, delay);
    this.checkpointTimer.unref();
  }

  /** One job at a time, so a checkpoint never races a seal in this process. */
  private queue(job: () => Promise<unknown>, failure: string): void {
    this.running = this.running.then(job).catch(() => this.logger.error(failure));
  }
}
