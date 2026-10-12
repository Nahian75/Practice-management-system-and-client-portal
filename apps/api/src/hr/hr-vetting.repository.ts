import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { SealedHrData } from './hr-data-cipher.js';

type Executor = Kysely<Database>;
export interface LifecycleRow {
  checklist_id: string; engagement_id: string; kind: 'joiner' | 'mover' | 'leaver'; effective_on: string;
  reason_category: string | null; checklist_state: 'open' | 'completed' | 'reopened'; item_id: string | null;
  code: string | null; title: string | null; owner_kind: string | null; required: boolean | null;
  due_on: string | null; item_state: 'open' | 'completed' | 'reopened' | null;
}
export interface RightToWorkStatusRow {
  id: string; engagement_id: string; version: number; result: 'passed' | 'failed' | 'follow_up_required';
  permission_type: 'british_or_irish' | 'settled' | 'pre_settled' | 'time_limited' | 'other';
  checked_on: string; expires_on: string | null; follow_up_on: string | null;
  overdue: boolean; action_required: boolean;
}
export interface ProfessionalRow {
  id: string; person_id: string; kind: 'qualification' | 'professional_registration' | 'practising_certificate';
  title: string; issuer: string; valid_from: string | null; valid_to: string | null;
  context: string | null; key_version: number | null; nonce: Buffer | null; ciphertext: Buffer | null;
  auth_tag: Buffer | null; recorded_by: string; recorded_at: Date;
  status: 'current' | 'expired' | 'restricted' | 'suspended' | 'not_verified' | null;
  checked_on: string | null; check_context: string | null; check_key_version: number | null;
  check_nonce: Buffer | null; check_ciphertext: Buffer | null; check_auth_tag: Buffer | null;
  checked_by: string | null; check_recorded_at: Date | null;
}

@Injectable()
export class HrVettingRepository {
  constructor(@Inject(DATABASE) private readonly db: Executor) {}

  transaction<T>(work: (trx: Executor) => Promise<T>): Promise<T> { return this.db.transaction().execute(work); }
  async newId(executor: Executor = this.db) {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  createChecklist(input: { id: string; personId: string; engagementId: string; kind: string;
    effectiveOn: string; reasonCategory: string | null; actorId: string }, executor: Executor) {
    return sql`select app.create_hr_lifecycle_checklist(${input.id}::uuid,${input.personId}::uuid,
      ${input.engagementId}::uuid,${input.kind},${input.effectiveOn}::date,${input.reasonCategory},
      ${input.actorId}::uuid)`.execute(executor);
  }

  addChecklistItem(input: { id: string; checklistId: string; code: string; title: string; ownerKind: string;
    required: boolean; dueOn: string | null; actorId: string }, executor: Executor) {
    return sql`select app.add_hr_lifecycle_item(${input.id}::uuid,${input.checklistId}::uuid,${input.code},
      ${input.title},${input.ownerKind},${input.required},${input.dueOn}::date,${input.actorId}::uuid)`
      .execute(executor);
  }

  recordItemEvent(input: { id: string; itemId: string; action: 'completed' | 'reopened';
    sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_lifecycle_item_event(${input.id}::uuid,${input.itemId}::uuid,${input.action},
      ${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},
      ${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  recordChecklistEvent(input: { id: string; checklistId: string; action: 'completed' | 'reopened';
    sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_lifecycle_checklist_event(${input.id}::uuid,${input.checklistId}::uuid,
      ${input.action},${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},
      ${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  lifecycle(personId: string, actorId: string) {
    return sql<LifecycleRow>`select * from app.read_hr_lifecycle(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  blockers(checklistId: string, actorId: string) {
    return sql<{ kind: string; resource_id: string; status: string }>`
      select * from app.read_hr_leaver_blockers(${checklistId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  recordRightToWork(input: { id: string; personId: string; engagementId: string; guidanceVersion: string;
    checkRoute: 'manual' | 'online' | 'digital_provider'; checkedOn: string;
    permissionType: 'british_or_irish' | 'settled' | 'pre_settled' | 'time_limited' | 'other';
    result: 'passed' | 'failed' | 'follow_up_required'; expiresOn: string | null; followUpOn: string | null;
    evidenceFileId: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql<{ version: number }>`select app.record_hr_right_to_work_check(${input.id}::uuid,
      ${input.personId}::uuid,${input.engagementId}::uuid,${input.guidanceVersion},${input.checkRoute},
      ${input.checkedOn}::date,${input.permissionType},${input.result},${input.expiresOn}::date,
      ${input.followUpOn}::date,${input.evidenceFileId}::uuid,${input.sealed.context},
      ${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid) as version`
      .execute(executor).then((result) => result.rows[0]!.version);
  }

  rightToWorkStatus(personId: string, actorId: string) {
    return sql<RightToWorkStatusRow>`select * from app.read_hr_right_to_work_status(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  rightToWorkChecks(personId: string, actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrRightToWorkChecksTable>>`
      select * from app.read_hr_right_to_work_checks(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  vettingDue(actorId: string) {
    return sql<{ person_id: string; account_id: string; display_name: string; check_id: string;
      engagement_id: string; result: 'passed' | 'failed' | 'follow_up_required'; expires_on: string | null;
      follow_up_on: string | null; overdue: boolean }>`select * from app.list_hr_vetting_due(${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  createProfessional(input: { id: string; personId: string; kind: string; title: string; issuer: string;
    validFrom: string | null; validTo: string | null; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.create_hr_professional_record(${input.id}::uuid,${input.personId}::uuid,${input.kind},
      ${input.title},${input.issuer},${input.validFrom}::date,${input.validTo}::date,${input.sealed.context},
      ${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  recordProfessionalCheck(input: { id: string; recordId: string; status: string; checkedOn: string;
    sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_professional_check(${input.id}::uuid,${input.recordId}::uuid,${input.status},
      ${input.checkedOn}::date,${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},
      ${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  professional(personId: string, actorId: string, managerProjection: boolean) {
    return sql<ProfessionalRow>`select * from app.read_hr_professional_records(${personId}::uuid,
      ${actorId}::uuid,${managerProjection}::boolean)`.execute(this.db).then((result) => result.rows);
  }
}
