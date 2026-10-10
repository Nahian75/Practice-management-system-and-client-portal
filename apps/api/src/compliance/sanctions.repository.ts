import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { ParsedSanctionsList } from './sanctions-list.js';

export type SanctionsFailure = 'download' | 'too_large' | 'format' | 'older_report' | 'database';

export interface SanctionsListVersion {
  id: string; version: number; reportDate: string; source: 'download' | 'upload';
  designationCount: number; nameCount: number; importedAt: Date;
}
export interface SanctionsStatus {
  listId: string | null; version: number | null; reportDate: string | null;
  lastSuccessAt: Date | null; lastFailureAt: Date | null; fresh: boolean;
}

@Injectable()
export class SanctionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  /** Returns a null list id when PostgreSQL refused an older report (it records that refusal itself). */
  async importList(parsed: ParsedSanctionsList, actorId: string | null, trx: Kysely<Database>) {
    const designations = parsed.designations.map((d) => ({
      unique_id: d.uniqueId, kind: d.kind, regime: d.regime, date_designated: d.dateDesignated,
      births: d.births, nationalities: d.nationalities,
    }));
    const names = parsed.designations.flatMap((d) => d.names.map((n) => ({
      unique_id: d.uniqueId, name: n.name, normalized: n.normalized, tokens: n.tokens, is_primary: n.isPrimary,
    })));
    const row = (await sql<{ list_id: string | null; changed: boolean }>`
      select list_id, changed from app.import_aml_sanctions_list(
        ${parsed.reportDate}::date, ${parsed.sha256}, ${parsed.byteSize}::integer,
        ${JSON.stringify(designations)}::jsonb, ${JSON.stringify(names)}::jsonb, ${actorId}::uuid
      )`.execute(trx)).rows[0]!;
    return { listId: row.list_id, changed: row.changed };
  }

  async recordFailure(failure: SanctionsFailure, actorId: string | null): Promise<void> {
    await sql`select app.record_aml_sanctions_failure(${failure}, ${actorId}::uuid)`.execute(this.db);
  }

  async status(executor: Kysely<Database> = this.db): Promise<SanctionsStatus> {
    const row = (await sql<{ list_id: string | null; version: number | null; report_date: string | null;
      last_success_at: Date | null; last_failure_at: Date | null; fresh: boolean }>`
      select list_id, version, report_date::text, last_success_at, last_failure_at, fresh from app.aml_sanctions_status()
    `.execute(executor)).rows[0]!;
    return { listId: row.list_id, version: row.version, reportDate: row.report_date,
      lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at, fresh: row.fresh };
  }

  async findList(id: string, executor: Kysely<Database> = this.db): Promise<SanctionsListVersion | undefined> {
    const row = await executor.selectFrom('aml_sanctions_lists').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toVersion(row) : undefined;
  }

  async listVersions(before?: string): Promise<SanctionsListVersion[]> {
    let query = this.db.selectFrom('aml_sanctions_lists').selectAll();
    if (before) query = query.where('id', '<', before);
    return (await query.orderBy('id', 'desc').limit(100).execute()).map(toVersion);
  }
}

function toVersion(row: { id: string; version: number; report_date: string; source: string; designation_count: number;
  name_count: number; imported_at: Date }): SanctionsListVersion {
  return { id: row.id, version: row.version, reportDate: row.report_date, source: row.source as 'download' | 'upload',
    designationCount: row.designation_count, nameCount: row.name_count, importedAt: row.imported_at };
}
