import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { PermissionsService } from '../auth/permissions/permissions.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Database } from '../database/schema.js';
import type { StaffRate, TimeEntry } from './finance.js';
import { FinanceRepository } from './finance.repository.js';

export const FINANCE_PAGE_SIZE = 100;

export interface FinanceActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type CreateRateResult =
  | { outcome: 'created'; rate: StaffRate }
  | { outcome: 'invalid_account' | 'duplicate' | 'changed_meanwhile' };

export type RecordTimeResult =
  | { outcome: 'created'; entry: TimeEntry }
  | { outcome: 'not_found' | 'not_open' | 'missing_rate' | 'changed_meanwhile' };

export type CorrectTimeResult =
  | { outcome: 'changed' | 'unchanged'; entry: TimeEntry }
  | { outcome: 'not_found' | 'already_voided' | 'changed_meanwhile' };

@Injectable()
export class FinanceService {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  async createRate(
    details: { accountId: string; hourlyRatePence: string; effectiveFrom: string },
    by: FinanceActor,
  ): Promise<CreateRateResult> {
    if (!(await this.finance.eligibleRateAccount(details.accountId))) {
      return { outcome: 'invalid_account' };
    }
    try {
      const rate = await this.finance.transaction(async (trx) => {
        const id = await this.finance.insertRate({ ...details, createdBy: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'rate.created',
          outcome: 'success',
          resource: { type: 'staff_rate', id },
          metadata: details,
          ...by.context,
        }, trx);
        return this.finance.findRate(id, trx);
      });
      return rate ? { outcome: 'created', rate } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      if (hasCode(error, '23505')) {
        return { outcome: 'duplicate' };
      }
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  async listRates(accountId?: string, before?: string): Promise<{ rates: StaffRate[]; next: string | null }> {
    const rates = await this.finance.listRates({ accountId, before, limit: FINANCE_PAGE_SIZE });
    return { rates, next: rates.length === FINANCE_PAGE_SIZE ? (rates.at(-1)?.id ?? null) : null };
  }

  async recordTime(
    matterId: string,
    details: { workedOn: string; minutes: number; description: string },
    by: FinanceActor,
  ): Promise<RecordTimeResult> {
    const matter = await this.finance.matterAccess(matterId, by.accountId, false);
    if (!matter) {
      return { outcome: 'not_found' };
    }
    if (matter.status !== 'open') {
      return { outcome: 'not_open' };
    }
    if (!(await this.finance.effectiveRate(by.accountId, details.workedOn))) {
      return { outcome: 'missing_rate' };
    }
    try {
      const entry = await this.finance.transaction(async (trx) => {
        const id = await this.finance.insertTime({ matterId, workerId: by.accountId, ...details }, trx);
        const created = await this.finance.findTime(id, by.accountId, false, trx);
        if (!created) {
          return undefined;
        }
        await this.audit.record({
          actor: by.actor,
          action: 'time.recorded',
          outcome: 'success',
          resource: { type: 'time_entry', id },
          metadata: { matterId, minutes: details.minutes, hourlyRatePence: created.hourlyRatePence },
          ...by.context,
        }, trx);
        return created;
      });
      return entry ? { outcome: 'created', entry } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  async listTime(matterId: string, viewerId: string, before?: string): Promise<{ timeEntries: TimeEntry[]; next: string | null } | undefined> {
    const viewAll = await this.permissions.has(viewerId, 'finance.view_all');
    const entries = await this.finance.listTime(matterId, viewerId, viewAll, { before, limit: FINANCE_PAGE_SIZE });
    if (!entries) {
      return undefined;
    }
    return { timeEntries: entries, next: entries.length === FINANCE_PAGE_SIZE ? (entries.at(-1)?.id ?? null) : null };
  }

  async findTime(id: string, viewerId: string): Promise<TimeEntry | undefined> {
    return this.finance.findTime(id, viewerId, await this.permissions.has(viewerId, 'finance.view_all'));
  }

  async correctTime(
    id: string,
    details: { replacement: { workedOn: string; minutes: number; description: string } | null; reason: string },
    by: FinanceActor,
  ): Promise<CorrectTimeResult> {
    try {
      return await this.finance.transaction(async (trx) => {
        const current = await this.finance.findOwnedForCorrection(id, by.accountId, trx);
        if (!current) {
          return { outcome: 'not_found' };
        }
        if (current.voided) {
          return { outcome: 'already_voided' };
        }
        const correction = await this.finance.insertCorrection({
          timeEntryId: id,
          replacement: details.replacement,
          reason: details.reason,
          correctedBy: by.accountId,
        }, trx);
        const entry = await this.finance.findOwnedForCorrection(id, by.accountId, trx);
        if (!entry) {
          return { outcome: 'changed_meanwhile' };
        }
        if (correction) {
          await this.recordCorrectionAudit(current, entry, details.replacement === null, by, trx);
        }
        return { outcome: correction ? 'changed' : 'unchanged', entry };
      });
    } catch (error) {
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  private recordCorrectionAudit(
    current: TimeEntry,
    changed: TimeEntry,
    voided: boolean,
    by: FinanceActor,
    trx: Kysely<Database>,
  ) {
    const fields = voided
      ? ['workedOn', 'minutes', 'description', 'hourlyRate']
      : [
          ...(changed.workedOn !== current.workedOn ? ['workedOn'] : []),
          ...(changed.minutes !== current.minutes ? ['minutes'] : []),
          ...(changed.description !== current.description ? ['description'] : []),
          ...(changed.hourlyRatePence !== current.hourlyRatePence ? ['hourlyRate'] : []),
        ];
    return this.audit.record({
      actor: by.actor,
      action: 'time.corrected',
      outcome: 'success',
      resource: { type: 'time_entry', id: current.id },
      metadata: { matterId: current.matterId, voided, fields: fields.join(',') },
      ...by.context,
    }, trx);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
