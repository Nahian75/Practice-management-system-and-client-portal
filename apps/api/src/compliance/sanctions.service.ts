import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActor } from '../audit/audit-event.js';
import type { RequestContext } from '../common/http/request-context.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MAX_SANCTIONS_LIST_BYTES, parseSanctionsList, SanctionsListError } from './sanctions-list.js';
import { SanctionsScreeningService } from './sanctions-screening.service.js';
import { SanctionsRepository, type SanctionsFailure, type SanctionsListVersion } from './sanctions.repository.js';

const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Checked every six hours, so a missed check still leaves the list fresh (48 hours). */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type ImportOutcome =
  | { outcome: 'imported' | 'unchanged'; list: SanctionsListVersion }
  | { outcome: 'refused'; reason: SanctionsFailure };

interface Importer { actor: AuditActor; accountId: string | null; context?: RequestContext }

@Injectable()
export class SanctionsService {
  private readonly logger = new Logger(SanctionsService.name);

  constructor(private readonly records: SanctionsRepository, private readonly audit: AuditService,
    private readonly screening: SanctionsScreeningService, @Inject(ENV) private readonly env: Env) {}

  status() { return this.records.status(); }

  async listVersions(before?: string) {
    const items = await this.records.listVersions(before);
    return { items, next: items.length === 100 ? items.at(-1)!.id : null };
  }

  /** Parses, validates and activates one list file. Every outcome, including a refusal, is recorded. */
  async importList(file: Readable, by: Importer): Promise<ImportOutcome> {
    let parsed;
    try {
      parsed = await parseSanctionsList(file);
    } catch (error) {
      if (!(error instanceof SanctionsListError)) throw error;
      await this.records.recordFailure(error.code, by.accountId);
      return { outcome: 'refused', reason: error.code };
    }
    const result = await this.records.transaction(async (trx) => {
      const imported = await this.records.importList(parsed, by.accountId, trx);
      if (!imported.listId) return undefined;
      const list = (await this.records.findList(imported.listId, trx))!;
      if (imported.changed) {
        await this.audit.record({ actor: by.actor, action: 'aml.sanctions_list_activated', outcome: 'success',
          resource: { type: 'aml_sanctions_list', id: list.id },
          metadata: { version: list.version, designations: list.designationCount }, ...by.context }, trx);
      }
      return { outcome: imported.changed ? 'imported' as const : 'unchanged' as const, list };
    });
    if (result?.outcome === 'imported') this.rescreenInBackground();
    return result ?? { outcome: 'refused', reason: 'older_report' };
  }

  /**
   * Every newly activated list is screened against every client with an open matter.
   * It runs after the import is committed, outside the request; tests screen clients directly.
   */
  private rescreenInBackground(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.screening.rescreenAll()
      .then((count) => this.logger.log(`Rescreened ${count} clients against the new sanctions list`))
      .catch(() => this.logger.error('Rescreening against the new sanctions list failed'));
  }

  /** Downloads the official list from SANCTIONS_LIST_URL. A failure leaves the last good version active. */
  async refresh(fetchList: typeof fetch = fetch): Promise<ImportOutcome> {
    const url = this.env.SANCTIONS_LIST_URL;
    if (!url) throw new Error('SANCTIONS_LIST_URL is not set');
    let response: Response;
    try {
      response = await fetchList(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      await this.records.recordFailure('download', null);
      return { outcome: 'refused', reason: 'download' };
    }
    if (!response.ok || !response.body) {
      await this.records.recordFailure('download', null);
      return { outcome: 'refused', reason: 'download' };
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_SANCTIONS_LIST_BYTES) {
      await response.body.cancel();
      await this.records.recordFailure('too_large', null);
      return { outcome: 'refused', reason: 'too_large' };
    }
    try {
      return await this.importList(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), { actor: { type: 'system' }, accountId: null });
    } catch {
      await this.records.recordFailure('download', null);
      return { outcome: 'refused', reason: 'download' };
    }
  }
}

/** Checks the official list on start and every six hours, when SANCTIONS_LIST_URL is set. */
@Injectable()
export class SanctionsRefresher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SanctionsRefresher.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly sanctions: SanctionsService, @Inject(ENV) private readonly env: Env) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test' || !this.env.SANCTIONS_LIST_URL) return;
    this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private run(): void {
    const running = this.sanctions.refresh()
      .then((result) => {
        if (result.outcome === 'refused') this.logger.warn(`Sanctions list refresh refused: ${result.reason}`);
      })
      .catch(() => this.logger.error('Sanctions list refresh failed'))
      .finally(() => {
        if (this.running === running) this.running = undefined;
        if (!this.stopping) {
          this.timer = setTimeout(() => this.run(), REFRESH_INTERVAL_MS);
          this.timer.unref();
        }
      });
    this.running = running;
  }
}
