import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, MatterStatus, TimeEntryCorrectionsTable } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import type { StaffRate, TimeCorrection, TimeEntry } from './finance.js';

interface RateRow {
  id: string;
  account_id: string;
  account_name: string;
  hourly_rate_pence: string;
  effective_from: string;
  created_by: string;
  creator_name: string;
  created_at: Date;
}

interface TimeRow {
  id: string;
  matter_id: string;
  worker_id: string;
  worker_name: string;
  worked_on: string;
  minutes: number;
  description: string;
  hourly_rate_pence: string;
  voided: boolean;
  recorded_at: Date;
}

type CorrectionRow = Selectable<TimeEntryCorrectionsTable> & { corrected_by_name: string };

@Injectable()
export class FinanceRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async eligibleRateAccount(accountId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', accountId)
      .where('kind', '=', 'staff')
      .where('status', '=', 'active')
      .where((eb) => eb.exists(
        eb.selectFrom('account_roles').select('id')
          .whereRef('account_roles.account_id', '=', 'accounts.id')
          .where('role', 'in', ['partner', 'fee_earner'])
          .where('revoked_at', 'is', null),
      ))
      .executeTakeFirst();
    return row !== undefined;
  }

  async insertRate(rate: { accountId: string; hourlyRatePence: string; effectiveFrom: string; createdBy: string }, trx: Kysely<Database>): Promise<string> {
    return (await trx.insertInto('staff_rates').values({
      account_id: rate.accountId,
      hourly_rate_pence: rate.hourlyRatePence,
      effective_from: rate.effectiveFrom,
      created_by: rate.createdBy,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async findRate(id: string, executor: Kysely<Database> = this.db): Promise<StaffRate | undefined> {
    const row = await this.rateRows(executor).where('staff_rates.id', '=', id).executeTakeFirst();
    return row && toRate(row);
  }

  async listRates(page: { accountId?: string; before?: string; limit: number }): Promise<StaffRate[]> {
    const rows = await this.rateRows(this.db)
      .$if(page.accountId !== undefined, (query) => query.where('staff_rates.account_id', '=', page.accountId as string))
      .$if(page.before !== undefined, (query) => query.where('staff_rates.id', '<', page.before as string))
      .orderBy('staff_rates.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map(toRate);
  }

  matterAccess(matterId: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<{ status: MatterStatus } | undefined> {
    let query = executor.selectFrom('matters').select('status').where('id', '=', matterId);
    if (!viewAll) {
      query = query.where(visibleTo(viewerId));
    }
    return query.executeTakeFirst();
  }

  async effectiveRate(accountId: string, workedOn: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    return (await executor.selectFrom('staff_rates').select('id')
      .where('account_id', '=', accountId)
      .where('effective_from', '<=', workedOn)
      .orderBy('effective_from', 'desc')
      .executeTakeFirst()) !== undefined;
  }

  async insertTime(entry: { matterId: string; workerId: string; workedOn: string; minutes: number; description: string }, trx: Kysely<Database>): Promise<string> {
    return (await trx.insertInto('time_entries').values({
      matter_id: entry.matterId,
      worker_id: entry.workerId,
      worked_on: entry.workedOn,
      minutes: entry.minutes,
      description: entry.description,
      recorded_by: entry.workerId,
    }).returning('id').executeTakeFirstOrThrow()).id;
  }

  async listTime(matterId: string, viewerId: string, viewAll: boolean, page: { before?: string; limit: number }): Promise<TimeEntry[] | undefined> {
    if (!(await this.matterAccess(matterId, viewerId, viewAll))) {
      return undefined;
    }
    const rows = await this.timeRows(this.db)
      .where('time_entries.matter_id', '=', matterId)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId)))
      .$if(page.before !== undefined, (query) => query.where('time_entries.id', '<', page.before as string))
      .orderBy('time_entries.id', 'desc')
      .limit(page.limit)
      .execute();
    return this.withCorrections(rows);
  }

  async findTime(id: string, viewerId: string, viewAll: boolean, executor: Kysely<Database> = this.db): Promise<TimeEntry | undefined> {
    const row = await this.timeRows(executor)
      .where('time_entries.id', '=', id)
      .$if(!viewAll, (query) => query.where(visibleTo(viewerId)))
      .executeTakeFirst();
    return row && (await this.withCorrections([row], executor))[0];
  }

  async findOwnedForCorrection(id: string, workerId: string, executor: Kysely<Database>): Promise<TimeEntry | undefined> {
    const row = await this.timeRows(executor)
      .where('time_entries.id', '=', id)
      .where('time_entries.worker_id', '=', workerId)
      .where(visibleTo(workerId))
      .executeTakeFirst();
    return row && (await this.withCorrections([row], executor))[0];
  }

  async insertCorrection(correction: {
    timeEntryId: string;
    replacement: { workedOn: string; minutes: number; description: string } | null;
    reason: string;
    correctedBy: string;
  }, trx: Kysely<Database>) {
    return trx.insertInto('time_entry_corrections').values({
      time_entry_id: correction.timeEntryId,
      to_worked_on: correction.replacement?.workedOn ?? null,
      to_minutes: correction.replacement?.minutes ?? null,
      to_description: correction.replacement?.description ?? null,
      reason: correction.reason,
      corrected_by: correction.correctedBy,
    }).returning(['id', 'from_worked_on', 'to_worked_on', 'from_minutes', 'to_minutes', 'from_description', 'to_description', 'from_hourly_rate_pence', 'to_hourly_rate_pence']).executeTakeFirst();
  }

  private rateRows(executor: Kysely<Database>) {
    return executor.selectFrom('staff_rates')
      .innerJoin('accounts as rate_account', 'rate_account.id', 'staff_rates.account_id')
      .innerJoin('accounts as rate_creator', 'rate_creator.id', 'staff_rates.created_by')
      .select([
        'staff_rates.id', 'staff_rates.account_id', 'rate_account.display_name as account_name',
        'staff_rates.hourly_rate_pence', 'staff_rates.effective_from', 'staff_rates.created_by',
        'rate_creator.display_name as creator_name', 'staff_rates.created_at',
      ]);
  }

  private timeRows(executor: Kysely<Database>) {
    return executor.selectFrom('time_entries')
      .innerJoin('matters', 'matters.id', 'time_entries.matter_id')
      .innerJoin('accounts as time_worker', 'time_worker.id', 'time_entries.worker_id')
      .select([
        'time_entries.id', 'time_entries.matter_id', 'time_entries.worker_id',
        'time_worker.display_name as worker_name', 'time_entries.worked_on',
        'time_entries.minutes', 'time_entries.description', 'time_entries.hourly_rate_pence',
        'time_entries.voided', 'time_entries.recorded_at',
      ]);
  }

  private async withCorrections(rows: TimeRow[], executor: Kysely<Database> = this.db): Promise<TimeEntry[]> {
    if (rows.length === 0) {
      return [];
    }
    const corrections = await executor.selectFrom('time_entry_corrections')
      .innerJoin('accounts as correcting_account', 'correcting_account.id', 'time_entry_corrections.corrected_by')
      .selectAll('time_entry_corrections')
      .select('correcting_account.display_name as corrected_by_name')
      .where('time_entry_id', 'in', rows.map((row) => row.id))
      .orderBy('time_entry_corrections.id')
      .execute();
    return rows.map((row) => toTime(row, corrections.filter((correction) => correction.time_entry_id === row.id)));
  }
}

function toRate(row: RateRow): StaffRate {
  return {
    id: row.id,
    account: { accountId: row.account_id, displayName: row.account_name },
    hourlyRatePence: row.hourly_rate_pence,
    effectiveFrom: row.effective_from,
    createdBy: { accountId: row.created_by, displayName: row.creator_name },
    createdAt: row.created_at,
  };
}

function toTime(row: TimeRow, corrections: CorrectionRow[]): TimeEntry {
  return {
    id: row.id,
    matterId: row.matter_id,
    worker: { accountId: row.worker_id, displayName: row.worker_name },
    workedOn: row.worked_on,
    minutes: row.minutes,
    description: row.description,
    hourlyRatePence: row.hourly_rate_pence,
    voided: row.voided,
    recordedAt: row.recorded_at,
    corrections: corrections.map((correction): TimeCorrection => ({
      id: correction.id,
      from: {
        workedOn: correction.from_worked_on,
        minutes: correction.from_minutes,
        description: correction.from_description,
        hourlyRatePence: correction.from_hourly_rate_pence,
      },
      to: correction.to_worked_on === null ? null : {
        workedOn: correction.to_worked_on,
        minutes: correction.to_minutes!,
        description: correction.to_description!,
        hourlyRatePence: correction.to_hourly_rate_pence!,
      },
      reason: correction.reason,
      correctedBy: { accountId: correction.corrected_by, displayName: correction.corrected_by_name },
      correctedAt: correction.corrected_at,
    })),
  };
}
