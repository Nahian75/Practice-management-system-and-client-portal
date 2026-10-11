import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { SealedComplianceData } from './compliance-data-cipher.js';
import type { SealedSuspicionData } from './suspicion-data-cipher.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { DisposalRun, RetentionSummary } from './retention.js';

export interface RetentionScheduleRow {
  id: string; client_id: string; relationship_ended_on: string; retention_years: number;
  dispose_after: string; governing_rule: string; evidence_context: string; evidence_key_version: number;
  evidence_nonce: Buffer; evidence_ciphertext: Buffer; evidence_auth_tag: Buffer;
  recorded_by: string; recorded_at: Date;
}
export interface LegalHoldRow {
  id: string; schedule_id: string; action: 'imposed' | 'reviewed' | 'released'; review_on: string | null;
  encryption_context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
  recorded_by: string; recorded_at: Date;
}
export interface ExportRow {
  id: string; client_id: string; encryption_context: string; key_version: number; nonce: Buffer;
  ciphertext: Buffer; auth_tag: Buffer; sha256: Buffer; byte_size: number; created_by: string; created_at: Date;
}
export interface RestrictedExportRow extends Omit<ExportRow, 'client_id'> { report_id: string }

@Injectable()
export class RetentionRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> { return this.db.transaction().execute(work); }
  async newId(executor: Kysely<Database> = this.db): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  async access(actorId: string): Promise<{ canRestricted: boolean; attentionCount: number }> {
    const row = (await sql<{ can_restricted: boolean; attention_count: number }>`select * from app.aml_compliance_access(${actorId}::uuid)`.execute(this.db)).rows[0];
    return { canRestricted: row?.can_restricted ?? false, attentionCount: row?.attention_count ?? 0 };
  }

  async clientChoices(actorId: string): Promise<Array<{ id: string; reference: string; kind: 'individual' | 'organisation'; name: string }>> {
    const rows = (await sql<{ id: string; reference: string; kind: 'individual' | 'organisation'; name: string }>`
      select * from app.list_aml_client_choices(${actorId}::uuid)`.execute(this.db)).rows;
    return rows.map((row) => ({ ...row, kind: row.kind as 'individual' | 'organisation' }));
  }

  async createSchedule(input: { id: string; clientId: string; endedOn: string; years: number; rule: string;
    sealed: SealedComplianceData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.record_aml_retention_schedule(${input.id}::uuid,${input.clientId}::uuid,${input.endedOn}::date,
      ${input.years}::smallint,${input.rule},${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},
      ${s.authTag},${input.actorId}::uuid)`.execute(trx);
  }

  async listSchedules(actorId: string): Promise<RetentionSummary[]> {
    const rows = (await sql<{ id: string; client_id: string; relationship_ended_on: string; retention_years: number;
      dispose_after: string; governing_rule: string; hold_action: RetentionSummary['holdAction']; hold_review_on: string | null;
      recorded_by: string; recorded_at: Date }>`select * from app.list_aml_retention_schedules(${actorId}::uuid)`.execute(this.db)).rows;
    return rows.map((r) => ({ id: r.id, clientId: r.client_id, relationshipEndedOn: r.relationship_ended_on,
      retentionYears: r.retention_years, disposeAfter: r.dispose_after, governingRule: r.governing_rule,
      holdAction: r.hold_action, holdReviewOn: r.hold_review_on, recordedBy: r.recorded_by, recordedAt: r.recorded_at }));
  }

  async schedule(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<RetentionScheduleRow | undefined> {
    return (await sql<RetentionScheduleRow>`select * from app.read_aml_retention_schedule(${id}::uuid,${actorId}::uuid)`.execute(executor)).rows[0];
  }
  async holds(scheduleId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<LegalHoldRow[]> {
    return (await sql<LegalHoldRow>`select * from app.read_aml_legal_hold_events(${scheduleId}::uuid,${actorId}::uuid)`.execute(executor)).rows;
  }
  async addHold(input: { id: string; scheduleId: string; action: LegalHoldRow['action']; reviewOn: string | null;
    sealed: SealedComplianceData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.record_aml_legal_hold_event(${input.id}::uuid,${input.scheduleId}::uuid,${input.action},
      ${input.reviewOn}::date,${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},
      ${input.actorId}::uuid)`.execute(trx);
  }

  async prepareDisposal(id: string, scheduleId: string, actorId: string,
    executor: Kysely<Database> = this.db): Promise<{ id: string; objectKeys: string[] } | undefined> {
    const row = (await sql<{ id: string; object_keys: string[] }>`select * from app.prepare_aml_disposal(
      ${id}::uuid,${scheduleId}::uuid,${actorId}::uuid)`.execute(executor)).rows[0];
    return row ? { id: row.id, objectKeys: row.object_keys } : undefined;
  }
  async finalizeDisposal(id: string, actorId: string, executor: Kysely<Database>): Promise<number> {
    return (await sql<{ count: number }>`select app.finalize_aml_disposal(${id}::uuid,${actorId}::uuid) as count`.execute(executor)).rows[0]!.count;
  }
  async listDisposals(actorId: string): Promise<DisposalRun[]> {
    const rows = (await sql<{ id: string; schedule_id: string; client_id: string; governing_rule: string;
      state: DisposalRun['state']; prepared_by: string; prepared_at: Date; completed_by: string | null;
      completed_at: Date | null; record_count: number | null }>`select * from app.list_aml_disposals(${actorId}::uuid)`.execute(this.db)).rows;
    return rows.map((r) => ({ id: r.id, scheduleId: r.schedule_id, clientId: r.client_id,
      governingRule: r.governing_rule, state: r.state, preparedBy: r.prepared_by, preparedAt: r.prepared_at,
      completedBy: r.completed_by, completedAt: r.completed_at, recordCount: r.record_count }));
  }

  matterIds(clientId: string) {
    return this.db.selectFrom('matters').select('id').where('client_id', '=', clientId).orderBy('id').execute().then((rows) => rows.map((r) => r.id));
  }
  holdIds(clientId: string) {
    return this.db.selectFrom('aml_holds').select('id').where('client_id', '=', clientId).orderBy('id').execute().then((rows) => rows.map((r) => r.id));
  }

  async createExport(input: { id: string; clientId: string; sealed: SealedComplianceData; sha256: Buffer;
    byteSize: number; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.create_aml_export(${input.id}::uuid,${input.clientId}::uuid,${s.context},
      ${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},${input.sha256},${input.byteSize}::integer,
      ${input.actorId}::uuid)`.execute(trx);
  }
  async listExports(actorId: string) {
    return (await sql<{ id: string; client_id: string; sha256: Buffer; byte_size: number; created_by: string; created_at: Date }>`
      select * from app.list_aml_exports(${actorId}::uuid)`.execute(this.db)).rows;
  }
  async export(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<ExportRow | undefined> {
    return (await sql<ExportRow>`select * from app.read_aml_export(${id}::uuid,${actorId}::uuid)`.execute(executor)).rows[0];
  }

  async createRestrictedExport(input: { id: string; reportId: string; sealed: SealedSuspicionData; sha256: Buffer;
    byteSize: number; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.create_aml_restricted_export(${input.id}::uuid,${input.reportId}::uuid,${s.context},
      ${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},${input.sha256},${input.byteSize}::integer,
      ${input.actorId}::uuid)`.execute(trx);
  }
  async restrictedExport(reportId: string, id: string, actorId: string): Promise<RestrictedExportRow | undefined> {
    return (await sql<RestrictedExportRow>`select * from app.read_aml_restricted_export(
      ${reportId}::uuid,${id}::uuid,${actorId}::uuid)`.execute(this.db)).rows[0];
  }
}
