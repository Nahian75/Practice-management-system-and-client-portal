import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, HrCaseKind, HrCaseRole, HrExportPurpose, HrRetentionCategory } from '../database/schema.js';
import type { SealedHrData } from './hr-data-cipher.js';

type Executor = Kysely<Database>;
type CaseEventKind = 'evidence' | 'meeting' | 'response' | 'notice' | 'outcome' | 'action' | 'appeal' | 'correction' | 'status';
type CaseState = 'open' | 'investigating' | 'decision_due' | 'appeal_open' | 'closed';

export interface CaseSummaryRow {
  id: string; person_id: string; kind: HrCaseKind; due_on: string | null; state: CaseState; opened_at: Date;
}
export interface CaseRow {
  id: string; person_id: string; kind: HrCaseKind; raised_by_person_id: string | null; policy_version: string;
  due_on: string | null; issue_context: string; issue_key_version: number; issue_nonce: Buffer;
  issue_ciphertext: Buffer; issue_auth_tag: Buffer; opened_by: string; opened_at: Date;
}
export interface CaseMemberRow {
  id: string; account_id: string; role: HrCaseRole; override_context: string | null; override_key_version: number | null;
  override_nonce: Buffer | null; override_ciphertext: Buffer | null; override_auth_tag: Buffer | null;
  added_by: string; added_at: Date; ending_id: string | null; reason_context: string | null;
  reason_key_version: number | null; reason_nonce: Buffer | null; reason_ciphertext: Buffer | null;
  reason_auth_tag: Buffer | null; ended_by: string | null; ended_at: Date | null;
}
export interface CaseEventRow {
  id: string; case_id: string; kind: CaseEventKind; state: CaseState | null; occurred_on: string;
  supersedes_event_id: string | null; context: string; key_version: number; nonce: Buffer; ciphertext: Buffer;
  auth_tag: Buffer; recorded_by: string; recorded_at: Date;
}
export interface CaseAccessRow {
  id: string; case_id: string; action: 'view' | 'export'; accessed_by: string; accessed_at: Date;
}
export interface RetentionRuleRow {
  id: string; category: HrRetentionCategory; version: number; effective_from: string; review_after_months: number;
  retain_months: number; governing_rule: string; rationale_context: string; rationale_key_version: number;
  rationale_nonce: Buffer; rationale_ciphertext: Buffer; rationale_auth_tag: Buffer; recorded_by: string; recorded_at: Date;
}
export interface RetentionSummaryRow {
  id: string; person_id: string; rule_id: string; category: HrRetentionCategory; source_id: string | null;
  basis_on: string; review_on: string; dispose_after: string; rule_version: number; governing_rule: string;
  hold_action: 'imposed' | 'reviewed' | 'released' | null; hold_review_on: string | null;
  recorded_by: string; recorded_at: Date;
}
export interface RetentionScheduleRow {
  id: string; person_id: string; rule_id: string; category: HrRetentionCategory; source_id: string | null;
  basis_on: string; review_on: string; dispose_after: string; evidence_context: string; evidence_key_version: number;
  evidence_nonce: Buffer; evidence_ciphertext: Buffer; evidence_auth_tag: Buffer; recorded_by: string; recorded_at: Date;
}
export interface LegalHoldRow {
  id: string; schedule_id: string; action: 'imposed' | 'reviewed' | 'released'; review_on: string | null;
  context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
  recorded_by: string; recorded_at: Date;
}
export interface DisposalRow {
  id: string; schedule_id: string; person_id: string; category: HrRetentionCategory; rule_version: number;
  governing_rule: string; state: 'prepared' | 'completed'; object_keys: string[]; prepared_by: string;
  prepared_at: Date; completed_by: string | null; completed_at: Date | null; record_count: number | null;
}
export interface ExportRow {
  id: string; person_id: string; purpose: HrExportPurpose; scopes: string[]; case_ids: string[];
  context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
  sha256: Buffer; byte_size: number; created_by: string; created_at: Date;
}
export interface ExportSummaryRow {
  id: string; person_id: string; purpose: HrExportPurpose; scopes: string[]; case_ids: string[];
  sha256: Buffer; byte_size: number; created_by: string; created_at: Date;
  decision: 'approved' | 'rejected' | null; decided_by: string | null; decided_at: Date | null;
}

@Injectable()
export class HrCasesRetentionRepository {
  constructor(@Inject(DATABASE) private readonly db: Executor) {}
  transaction<T>(work: (trx: Executor) => Promise<T>): Promise<T> { return this.db.transaction().execute(work); }
  async newId(executor: Executor = this.db): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() id`.execute(executor)).rows[0]!.id;
  }

  createCase(input: { id: string; personId: string; kind: HrCaseKind; raisedByPersonId: string | null;
    policyVersion: string; dueOn: string | null; sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.create_hr_case(${input.id}::uuid,${input.personId}::uuid,${input.kind},
      ${input.raisedByPersonId}::uuid,${input.policyVersion},${input.dueOn}::date,${s.context},${s.keyVersion}::smallint,
      ${s.nonce},${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  addMember(input: { id: string; caseId: string; accountId: string; role: HrCaseRole;
    override: SealedHrData | null; actorId: string }, executor: Executor) {
    const s = input.override;
    return sql`select app.add_hr_case_member(${input.id}::uuid,${input.caseId}::uuid,${input.accountId}::uuid,
      ${input.role},${s?.context ?? null},${s?.keyVersion ?? null}::smallint,${s?.nonce ?? null},
      ${s?.ciphertext ?? null},${s?.authTag ?? null},${input.actorId}::uuid)`.execute(executor);
  }
  endMember(input: { id: string; membershipId: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.end_hr_case_member(${input.id}::uuid,${input.membershipId}::uuid,${s.context},
      ${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  addCaseEvent(input: { id: string; caseId: string; kind: CaseEventKind; state: CaseState | null;
    occurredOn: string; supersedesEventId: string | null; sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.record_hr_case_event(${input.id}::uuid,${input.caseId}::uuid,${input.kind},${input.state},
      ${input.occurredOn}::date,${input.supersedesEventId}::uuid,${s.context},${s.keyVersion}::smallint,
      ${s.nonce},${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  listCases(actorId: string): Promise<CaseSummaryRow[]> {
    return sql<CaseSummaryRow>`select * from app.list_hr_cases(${actorId}::uuid)`.execute(this.db).then((r) => r.rows);
  }
  caseRow(id: string, actorId: string, access: 'view' | 'export', executor: Executor): Promise<CaseRow | undefined> {
    return sql<CaseRow>`select * from app.read_hr_case(${id}::uuid,${actorId}::uuid,${access})`
      .execute(executor).then((r) => r.rows[0]);
  }
  caseMembers(id: string, actorId: string, executor: Executor): Promise<CaseMemberRow[]> {
    return sql<CaseMemberRow>`select * from app.read_hr_case_members(${id}::uuid,${actorId}::uuid)`
      .execute(executor).then((r) => r.rows);
  }
  caseEvents(id: string, actorId: string, executor: Executor): Promise<CaseEventRow[]> {
    return sql<CaseEventRow>`select * from app.read_hr_case_events(${id}::uuid,${actorId}::uuid)`
      .execute(executor).then((r) => r.rows);
  }
  caseAccesses(id: string, actorId: string): Promise<CaseAccessRow[]> {
    return sql<CaseAccessRow>`select * from app.read_hr_case_accesses(${id}::uuid,${actorId}::uuid)`
      .execute(this.db).then((r) => r.rows);
  }

  createRule(input: { id: string; category: HrRetentionCategory; effectiveFrom: string; reviewAfterMonths: number;
    retainMonths: number; governingRule: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.create_hr_retention_rule(${input.id}::uuid,${input.category},${input.effectiveFrom}::date,
      ${input.reviewAfterMonths}::smallint,${input.retainMonths}::smallint,${input.governingRule},${s.context},
      ${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  listRules(actorId: string): Promise<RetentionRuleRow[]> {
    return sql<RetentionRuleRow>`select * from app.list_hr_retention_rules(${actorId}::uuid)`
      .execute(this.db).then((r) => r.rows);
  }
  createSchedule(input: { id: string; personId: string; ruleId: string; sourceId: string | null;
    basisOn: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.create_hr_retention_schedule(${input.id}::uuid,${input.personId}::uuid,${input.ruleId}::uuid,
      ${input.sourceId}::uuid,${input.basisOn}::date,${s.context},${s.keyVersion}::smallint,${s.nonce},
      ${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  listSchedules(actorId: string): Promise<RetentionSummaryRow[]> {
    return sql<RetentionSummaryRow>`select * from app.list_hr_retention_schedules(${actorId}::uuid)`
      .execute(this.db).then((r) => r.rows);
  }
  schedule(id: string, actorId: string, executor: Executor = this.db): Promise<RetentionScheduleRow | undefined> {
    return sql<RetentionScheduleRow>`select * from app.read_hr_retention_schedule(${id}::uuid,${actorId}::uuid)`
      .execute(executor).then((r) => r.rows[0]);
  }
  holds(id: string, actorId: string, executor: Executor = this.db): Promise<LegalHoldRow[]> {
    return sql<LegalHoldRow>`select * from app.read_hr_legal_holds(${id}::uuid,${actorId}::uuid)`
      .execute(executor).then((r) => r.rows);
  }
  addHold(input: { id: string; scheduleId: string; action: LegalHoldRow['action']; reviewOn: string | null;
    sealed: SealedHrData; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.record_hr_legal_hold(${input.id}::uuid,${input.scheduleId}::uuid,${input.action},
      ${input.reviewOn}::date,${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},
      ${input.actorId}::uuid)`.execute(executor);
  }
  prepareDisposal(id: string, scheduleId: string, actorId: string, executor: Executor) {
    return sql<{ id: string; object_keys: string[] }>`select * from app.prepare_hr_disposal(
      ${id}::uuid,${scheduleId}::uuid,${actorId}::uuid)`.execute(executor).then((r) => {
        const row = r.rows[0]; return row ? { id: row.id, objectKeys: row.object_keys } : undefined;
      });
  }
  finalizeDisposal(id: string, actorId: string, executor: Executor): Promise<number> {
    return sql<{ count: number }>`select app.finalize_hr_disposal(${id}::uuid,${actorId}::uuid) count`
      .execute(executor).then((r) => r.rows[0]!.count);
  }
  listDisposals(actorId: string): Promise<DisposalRow[]> {
    return sql<DisposalRow>`select * from app.list_hr_disposals(${actorId}::uuid)`.execute(this.db).then((r) => r.rows);
  }

  createExport(input: { id: string; personId: string; purpose: HrExportPurpose; scopes: string[]; caseIds: string[];
    sealed: SealedHrData; sha256: Buffer; byteSize: number; actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.create_hr_export(${input.id}::uuid,${input.personId}::uuid,${input.purpose},
      ${sql.val(input.scopes)}::text[],${sql.val(input.caseIds)}::uuid[],${s.context},${s.keyVersion}::smallint,
      ${s.nonce},${s.ciphertext},${s.authTag},${input.sha256},${input.byteSize},${input.actorId}::uuid)`.execute(executor);
  }
  decideExport(input: { id: string; exportId: string; decision: 'approved' | 'rejected'; sealed: SealedHrData;
    actorId: string }, executor: Executor) {
    const s = input.sealed;
    return sql`select app.decide_hr_export(${input.id}::uuid,${input.exportId}::uuid,${input.decision},${s.context},
      ${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  listExports(actorId: string): Promise<ExportSummaryRow[]> {
    return sql<ExportSummaryRow>`select * from app.list_hr_exports(${actorId}::uuid)`.execute(this.db).then((r) => r.rows);
  }
  exportRow(id: string, actorId: string, download: boolean, executor: Executor): Promise<ExportRow | undefined> {
    return sql<ExportRow>`select * from app.read_hr_export(${id}::uuid,${actorId}::uuid,${download})`
      .execute(executor).then((r) => r.rows[0]);
  }
}
