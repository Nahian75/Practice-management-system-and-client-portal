import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import type { SealedSuspicionData } from './suspicion-data-cipher.js';
import type { RestrictedAccess, RestrictedReportSummary } from './restricted-reports.js';

export interface SealedRow {
  encryption_context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
}
export interface ReportRow extends SealedRow {
  id: string; client_id: string; matter_id: string | null; finance_transaction_id: string | null;
  observed_on: string; submitted_by: string; submitted_at: Date;
}
export interface AttachmentRow {
  id: string; report_id: string; metadata_context: string; metadata_key_version: number; metadata_nonce: Buffer;
  metadata_ciphertext: Buffer; metadata_auth_tag: Buffer; media_type: string; size_bytes: number; sha256: Buffer;
  storage_key: string; file_key_version: number; file_key_nonce: Buffer; wrapped_file_key: Buffer; file_key_tag: Buffer;
  uploaded_at: Date;
}
export interface DecisionRow extends SealedRow {
  id: string; report_id: string; external_report_required: boolean; decided_by: string; decided_at: Date;
}
export interface ExternalRow extends SealedRow {
  id: string; internal_report_id: string; report_kind: 'sar' | 'terrorist_financing_report';
  daml_datf_requested: boolean; submitted_by: string; submitted_at: Date; recorded_at: Date;
}
export interface EventRow extends SealedRow {
  id: string; external_report_id: string; outcome: 'requested' | 'granted' | 'refused' | 'withdrawn' | 'expired';
  received_at: Date; expires_at: Date | null; recorded_by: string; recorded_at: Date;
}

@Injectable()
export class RestrictedReportsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> { return this.db.transaction().execute(work); }
  async newId(executor: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  async submit(input: { id: string; clientId: string; matterId: string | null; transactionId: string | null;
    observedOn: string; sealed: SealedSuspicionData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.submit_aml_internal_report(${input.id}::uuid, ${input.clientId}::uuid,
      ${input.matterId}::uuid, ${input.transactionId}::uuid, ${input.observedOn}::date,
      ${s.context}, ${s.keyVersion}::smallint, ${s.nonce}, ${s.ciphertext}, ${s.authTag}, ${input.actorId}::uuid)`.execute(trx);
  }

  async addAttachment(input: { id: string; reportId: string; metadata: SealedSuspicionData; mediaType: string;
    sizeBytes: number; sha256: Buffer; storageKey: string; fileKey: SealedSecret; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const m = input.metadata, k = input.fileKey;
    await sql`select app.add_aml_internal_report_attachment(${input.id}::uuid, ${input.reportId}::uuid,
      ${m.context}, ${m.keyVersion}::smallint, ${m.nonce}, ${m.ciphertext}, ${m.authTag}, ${input.mediaType},
      ${input.sizeBytes}, ${input.sha256}, ${input.storageKey}, ${k.keyVersion}::smallint, ${k.nonce}, ${k.ciphertext},
      ${k.authTag}, ${input.actorId}::uuid)`.execute(trx);
  }

  async list(actorId: string, before?: string): Promise<RestrictedReportSummary[]> {
    const rows = (await sql<{ id: string; observed_on: string; submitted_at: Date; decided: boolean }>`
      select id, observed_on::text, submitted_at, decided from app.list_aml_internal_reports(${actorId}::uuid, ${before ?? null}::uuid)
    `.execute(this.db)).rows;
    return rows.map((r) => ({ id: r.id, observedOn: r.observed_on, submittedAt: r.submitted_at, decided: r.decided }));
  }

  async read(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<ReportRow | undefined> {
    return (await sql<ReportRow>`select * from app.read_aml_internal_report(${id}::uuid, ${actorId}::uuid)`.execute(executor)).rows[0];
  }
  async attachments(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<AttachmentRow[]> {
    return (await sql<AttachmentRow>`select * from app.read_aml_internal_report_attachments(${id}::uuid, ${actorId}::uuid)`.execute(executor)).rows;
  }
  async decision(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<DecisionRow | undefined> {
    return (await sql<DecisionRow>`select * from app.read_aml_internal_report_decision(${id}::uuid, ${actorId}::uuid)`.execute(executor)).rows[0];
  }
  async external(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<ExternalRow | undefined> {
    return (await sql<ExternalRow>`select * from app.read_aml_external_reports(${id}::uuid, ${actorId}::uuid)`.execute(executor)).rows[0];
  }
  async events(id: string, actorId: string, executor: Kysely<Database> = this.db): Promise<EventRow[]> {
    return (await sql<EventRow>`select * from app.read_aml_daml_datf_events(${id}::uuid, ${actorId}::uuid)`.execute(executor)).rows;
  }

  async decide(input: { id: string; reportId: string; required: boolean; sealed: SealedSuspicionData;
    holdId: string | null; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.decide_aml_internal_report(${input.id}::uuid, ${input.reportId}::uuid, ${input.required},
      ${s.context}, ${s.keyVersion}::smallint, ${s.nonce}, ${s.ciphertext}, ${s.authTag},
      ${input.holdId}::uuid, ${input.actorId}::uuid)`.execute(trx);
  }

  async recordExternal(input: { id: string; reportId: string; kind: string; requested: boolean; submittedAt: string;
    sealed: SealedSuspicionData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.record_aml_external_report(${input.id}::uuid, ${input.reportId}::uuid, ${input.kind},
      ${input.requested}, ${input.submittedAt}::timestamptz, ${s.context}, ${s.keyVersion}::smallint,
      ${s.nonce}, ${s.ciphertext}, ${s.authTag}, ${input.actorId}::uuid)`.execute(trx);
  }

  async recordEvent(input: { id: string; externalId: string; outcome: string; receivedAt: string; expiresAt: string | null;
    sealed: SealedSuspicionData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.record_aml_daml_datf_event(${input.id}::uuid, ${input.externalId}::uuid, ${input.outcome},
      ${input.receivedAt}::timestamptz, ${input.expiresAt}::timestamptz, ${s.context}, ${s.keyVersion}::smallint,
      ${s.nonce}, ${s.ciphertext}, ${s.authTag}, ${input.actorId}::uuid)`.execute(trx);
  }

  async attachmentForDownload(id: string, actorId: string): Promise<AttachmentRow | undefined> {
    return (await sql<AttachmentRow>`select * from app.download_aml_internal_report_attachment(${id}::uuid, ${actorId}::uuid)`.execute(this.db)).rows[0];
  }

  async accessLog(reportId: string, actorId: string): Promise<RestrictedAccess[]> {
    const rows = (await sql<{ id: string; action: 'view' | 'download' | 'export'; attachment_id: string | null;
      accessed_by: string; accessed_at: Date }>`select * from app.list_aml_restricted_access(${reportId}::uuid, ${actorId}::uuid)`.execute(this.db)).rows;
    return rows.map((r) => ({ id: r.id, action: r.action, attachmentId: r.attachment_id,
      accessedBy: r.accessed_by, accessedAt: r.accessed_at }));
  }
}
