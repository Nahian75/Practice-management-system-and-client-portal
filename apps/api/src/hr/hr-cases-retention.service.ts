import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { Database, HrCaseKind, HrCaseRole, HrExportPurpose, HrRetentionCategory } from '../database/schema.js';
import { HrCompetenceService } from './hr-competence.service.js';
import {
  HrCasesRetentionRepository, type CaseEventRow, type CaseMemberRow, type CaseRow, type ExportRow,
  type LegalHoldRow, type RetentionRuleRow, type RetentionScheduleRow,
} from './hr-cases-retention.repository.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrFileVault } from './hr-file-vault.js';
import { HrLeaveService } from './hr-leave.service.js';
import { HrService, type HrActor } from './hr.service.js';
import { HrVettingService } from './hr-vetting.service.js';

const MAX_EXPORT_BYTES = 10_000_000;
export type HrChange<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };
export type ExportScope = 'personal' | 'employment' | 'leave' | 'health' | 'vetting' | 'competence' | 'cases';
type CaseEventKind = CaseEventRow['kind'];
type CaseState = NonNullable<CaseEventRow['state']>;

@Injectable()
export class HrCasesRetentionService {
  constructor(
    private readonly records: HrCasesRetentionRepository,
    private readonly cipher: HrDataCipher,
    private readonly files: HrFileVault,
    private readonly audit: AuditService,
    private readonly hr: HrService,
    private readonly leave: HrLeaveService,
    private readonly vetting: HrVettingService,
    private readonly competence: HrCompetenceService,
  ) {}

  createCase(input: { personId: string; kind: HrCaseKind; raisedByPersonId: string | null;
    policyVersion: string; dueOn: string | null; issue: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createCase({ id, ...input,
        sealed: this.cipher.seal({ issue: input.issue }, `hr-case:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.case_opened', 'hr_case', id, { kind: input.kind }, by, trx);
      return { id };
    }));
  }

  addMember(caseId: string, input: { accountId: string; role: HrCaseRole; separationOverride: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addMember({ id, caseId, accountId: input.accountId, role: input.role,
        override: input.separationOverride === null ? null : this.cipher.seal(
          { reason: input.separationOverride }, `hr-case-role-override:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.case_member_added', 'hr_case', caseId, { membershipId: id, role: input.role }, by, trx);
      return { id };
    }));
  }

  endMember(membershipId: string, reason: string, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.endMember({ id, membershipId,
        sealed: this.cipher.seal({ reason }, `hr-case-membership-ending:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.case_member_ended', 'hr_case_membership', membershipId, {}, by, trx);
      return { id };
    }));
  }

  addEvent(caseId: string, input: { kind: CaseEventKind; state: CaseState | null; occurredOn: string;
    supersedesEventId: string | null; summary: string; details: string; evidenceReference: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addCaseEvent({ id, caseId, kind: input.kind, state: input.state,
        occurredOn: input.occurredOn, supersedesEventId: input.supersedesEventId,
        sealed: this.cipher.seal({ summary: input.summary, details: input.details,
          evidenceReference: input.evidenceReference }, `hr-case-event:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.case_event_recorded', 'hr_case', caseId, { eventId: id, kind: input.kind }, by, trx);
      return { id };
    }));
  }

  async listCases(actorId: string) {
    try {
      return (await this.records.listCases(actorId)).map((row) => ({ id: row.id, personId: row.person_id,
        kind: row.kind, dueOn: row.due_on, state: row.state, openedAt: row.opened_at }));
    } catch (error) { if (hidden(error)) return []; throw error; }
  }

  async case(caseId: string, by: HrActor, access: 'view' | 'export' = 'view') {
    try {
      return await this.records.transaction(async (trx) => {
        const row = await this.records.caseRow(caseId, by.accountId, access, trx);
        if (!row) return undefined;
        const [members, events] = await Promise.all([
          this.records.caseMembers(caseId, by.accountId, trx), this.records.caseEvents(caseId, by.accountId, trx),
        ]);
        await this.log('hr.case_viewed', 'hr_case', caseId, { access }, by, trx);
        return this.mapCase(row, members, events);
      });
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  async accesses(caseId: string, actorId: string) {
    try { return (await this.records.caseAccesses(caseId, actorId)).map((row) => ({ id: row.id,
      action: row.action, accessedBy: row.accessed_by, accessedAt: row.accessed_at })); }
    catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  createRule(input: { category: HrRetentionCategory; effectiveFrom: string; reviewAfterMonths: number;
    retainMonths: number; governingRule: string; rationale: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createRule({ id, ...input, sealed: this.cipher.seal(
        { rationale: input.rationale }, `hr-retention-rule:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.retention_rule_created', 'hr_retention_rule', id, { category: input.category }, by, trx);
      return { id };
    }));
  }

  async rules(actorId: string) {
    return (await this.records.listRules(actorId)).map((row) => this.mapRule(row));
  }

  createSchedule(input: { personId: string; ruleId: string; sourceId: string | null; basisOn: string; evidence: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createSchedule({ id, ...input, sealed: this.cipher.seal(
        { evidence: input.evidence }, `hr-retention-schedule:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.retention_scheduled', 'hr_retention_schedule', id, { personId: input.personId }, by, trx);
      return { id };
    }));
  }

  async schedules(actorId: string) {
    return (await this.records.listSchedules(actorId)).map((row) => ({ id: row.id, personId: row.person_id,
      ruleId: row.rule_id, category: row.category, sourceId: row.source_id, basisOn: row.basis_on,
      reviewOn: row.review_on, disposeAfter: row.dispose_after, ruleVersion: row.rule_version,
      governingRule: row.governing_rule, currentHold: row.hold_action ?
        { action: row.hold_action, reviewOn: row.hold_review_on } : null,
      recordedBy: row.recorded_by, recordedAt: row.recorded_at }));
  }

  async schedule(id: string, actorId: string) {
    try {
      const [row, holds] = await Promise.all([this.records.schedule(id, actorId), this.records.holds(id, actorId)]);
      return row ? this.mapSchedule(row, holds) : undefined;
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  addHold(scheduleId: string, input: { action: LegalHoldRow['action']; reviewOn: string | null;
    authority: string; reason: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addHold({ id, scheduleId, action: input.action, reviewOn: input.reviewOn,
        sealed: this.cipher.seal({ authority: input.authority, reason: input.reason }, `hr-legal-hold:${id}`),
        actorId: by.accountId }, trx);
      await this.log(`hr.legal_hold_${input.action}`, 'hr_retention_schedule', scheduleId, {}, by, trx);
      return { id };
    }));
  }

  async disposals(actorId: string) { return (await this.records.listDisposals(actorId)).map((row) => this.mapDisposal(row)); }

  async dispose(scheduleId: string, by: HrActor) {
    try {
      const proposed = await this.records.newId();
      const id = await this.records.transaction(async (trx) => {
        const prepared = await this.records.prepareDisposal(proposed, scheduleId, by.accountId, trx);
        if (!prepared) return undefined;
        for (const key of prepared.objectKeys) await this.files.discard(key);
        const count = await this.records.finalizeDisposal(prepared.id, by.accountId, trx);
        await this.log('hr.record_disposed', 'hr_disposal_run', prepared.id, { count }, by, trx);
        return prepared.id;
      });
      if (!id) return { outcome: 'conflict' as const };
      const value = (await this.disposals(by.accountId)).find((item) => item.id === id);
      return value ? { outcome: 'changed' as const, value } : { outcome: 'not_found' as const };
    } catch (error) { return outcome(error); }
  }

  async createExport(input: { personId: string; purpose: HrExportPurpose; scopes: ExportScope[]; reason: string }, by: HrActor) {
    try {
      const { bundle, caseIds } = await this.bundle(input, by);
      const json = JSON.stringify(bundle, null, 2), bytes = Buffer.from(json, 'utf8');
      if (bytes.length > MAX_EXPORT_BYTES) return { outcome: 'conflict' as const };
      const hash = createHash('sha256').update(bytes).digest();
      const id = await this.records.transaction(async (trx) => {
        const exportId = await this.records.newId(trx);
        await this.records.createExport({ id: exportId, personId: input.personId, purpose: input.purpose,
          scopes: input.scopes, caseIds, sealed: this.cipher.seal({ json }, `hr-export:${exportId}`),
          sha256: hash, byteSize: bytes.length, actorId: by.accountId }, trx);
        await this.log('hr.export_prepared', 'hr_export', exportId,
          { personId: input.personId, byteSize: bytes.length }, by, trx);
        return exportId;
      });
      const value = (await this.exports(by.accountId)).find((item) => item.id === id);
      return value ? { outcome: 'changed' as const, value } : { outcome: 'not_found' as const };
    } catch (error) { return outcome(error); }
  }

  async exports(actorId: string) {
    return (await this.records.listExports(actorId)).map((row) => ({ id: row.id, personId: row.person_id,
      purpose: row.purpose, scopes: row.scopes, caseIds: row.case_ids, sha256: row.sha256.toString('hex'),
      byteSize: row.byte_size, createdBy: row.created_by, createdAt: row.created_at, decision: row.decision,
      decidedBy: row.decided_by, decidedAt: row.decided_at }));
  }

  async previewExport(id: string, by: HrActor) {
    try {
      return await this.records.transaction(async (trx) => {
        const row = await this.records.exportRow(id, by.accountId, false, trx);
        if (!row) return undefined;
        const body = this.openExport(row);
        await this.log('hr.export_reviewed', 'hr_export', id, {}, by, trx);
        return { id, sha256: row.sha256.toString('hex'), bundle: JSON.parse(body.toString('utf8')) as unknown };
      });
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  decideExport(exportId: string, input: { decision: 'approved' | 'rejected'; note: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.decideExport({ id, exportId, decision: input.decision,
        sealed: this.cipher.seal({ note: input.note }, `hr-export-decision:${id}`), actorId: by.accountId }, trx);
      await this.log(`hr.export_${input.decision}`, 'hr_export', exportId, {}, by, trx);
      return { id };
    }));
  }

  async downloadExport(id: string, by: HrActor) {
    try {
      return await this.records.transaction(async (trx) => {
        const row = await this.records.exportRow(id, by.accountId, true, trx);
        if (!row) return undefined;
        const body = this.openExport(row);
        await this.log('hr.export_downloaded', 'hr_export', id, {}, by, trx);
        return { body, sha256: row.sha256.toString('hex') };
      });
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  private async bundle(input: { personId: string; purpose: HrExportPurpose; scopes: ExportScope[]; reason: string }, by: HrActor) {
    const data: Record<string, unknown> = {};
    if (input.scopes.includes('personal') || input.scopes.includes('employment')) {
      const record = await this.hr.record(input.personId, by); if (!record) throw new MissingRecord();
      if (input.scopes.includes('personal')) data['personal'] = { contact: record.contact,
        privateDetails: record.privateDetails, corrections: record.corrections, files: record.files };
      if (input.scopes.includes('employment')) data['employment'] = { person: {
        personId: record.personId, accountId: record.accountId, displayName: record.displayName,
        workEmail: record.workEmail, accountStatus: record.accountStatus }, engagements: record.engagements,
        terms: record.terms, managerEvents: record.managerEvents, workPatterns: record.workPatterns };
    }
    if (input.scopes.includes('leave')) {
      const value = await this.leave.leave(input.personId, by.accountId); if (!value) throw new MissingRecord(); data['leave'] = value;
    }
    if (input.scopes.includes('health')) {
      const [health, adjustments] = await Promise.all([
        this.leave.health(input.personId, by), this.leave.adjustments(input.personId, by, false),
      ]); if (!health || !adjustments) throw new MissingRecord(); data['health'] = { health, adjustments };
    }
    if (input.scopes.includes('vetting')) {
      const [lifecycle, vetting] = await Promise.all([
        this.vetting.lifecycle(input.personId, by.accountId), this.vetting.vetting(input.personId, by, 'hr'),
      ]); if (!lifecycle || !vetting) throw new MissingRecord(); data['vetting'] = { lifecycle, vetting };
    }
    if (input.scopes.includes('competence')) {
      const value = await this.competence.competence(input.personId, by, true);
      if (!value) throw new MissingRecord(); data['competence'] = value;
    }
    const caseIds: string[] = [];
    if (input.scopes.includes('cases')) {
      const cases = (await this.listCases(by.accountId)).filter((item) => item.personId === input.personId);
      const detail = [];
      for (const item of cases) { const value = await this.case(item.id, by, 'export');
        if (!value) throw new MissingRecord(); caseIds.push(item.id); detail.push(value); }
      data['cases'] = { coverage: 'cases assigned to the preparer', items: detail };
    }
    return { caseIds, bundle: { schemaVersion: 1, kind: 'hr_export', personId: input.personId,
      purpose: input.purpose, reason: input.reason, scopes: input.scopes, preparedAt: new Date().toISOString(), data } };
  }

  private mapCase(row: CaseRow, members: CaseMemberRow[], events: CaseEventRow[]) {
    const issue = this.cipher.open<{ issue: string }>({ context: row.issue_context, keyVersion: row.issue_key_version,
      nonce: row.issue_nonce, ciphertext: row.issue_ciphertext, authTag: row.issue_auth_tag }).issue;
    return { id: row.id, personId: row.person_id, kind: row.kind, raisedByPersonId: row.raised_by_person_id,
      policyVersion: row.policy_version, dueOn: row.due_on, issue, openedBy: row.opened_by, openedAt: row.opened_at,
      members: members.map((member) => this.mapMember(member)), events: events.map((event) => this.mapEvent(event)) };
  }
  private mapMember(row: CaseMemberRow) {
    const override = openOptional<{ reason: string }>(this.cipher, row.override_context, row.override_key_version,
      row.override_nonce, row.override_ciphertext, row.override_auth_tag);
    const ending = openOptional<{ reason: string }>(this.cipher, row.reason_context, row.reason_key_version,
      row.reason_nonce, row.reason_ciphertext, row.reason_auth_tag);
    return { id: row.id, accountId: row.account_id, role: row.role, separationOverride: override?.reason ?? null,
      addedBy: row.added_by, addedAt: row.added_at, ending: row.ending_id ? { id: row.ending_id,
        reason: ending?.reason ?? '', endedBy: row.ended_by!, endedAt: row.ended_at! } : null };
  }
  private mapEvent(row: CaseEventRow) {
    const value = open<{ summary: string; details: string; evidenceReference: string | null }>(this.cipher, row);
    return { id: row.id, kind: row.kind, state: row.state, occurredOn: row.occurred_on,
      supersedesEventId: row.supersedes_event_id, ...value, recordedBy: row.recorded_by, recordedAt: row.recorded_at };
  }
  private mapRule(row: RetentionRuleRow) {
    return { id: row.id, category: row.category, version: row.version, effectiveFrom: row.effective_from,
      reviewAfterMonths: row.review_after_months, retainMonths: row.retain_months, governingRule: row.governing_rule,
      rationale: this.cipher.open<{ rationale: string }>({ context: row.rationale_context,
        keyVersion: row.rationale_key_version, nonce: row.rationale_nonce, ciphertext: row.rationale_ciphertext,
        authTag: row.rationale_auth_tag }).rationale, recordedBy: row.recorded_by, recordedAt: row.recorded_at };
  }
  private mapSchedule(row: RetentionScheduleRow, holds: LegalHoldRow[]) {
    return { id: row.id, personId: row.person_id, ruleId: row.rule_id, category: row.category, sourceId: row.source_id,
      basisOn: row.basis_on, reviewOn: row.review_on, disposeAfter: row.dispose_after,
      evidence: this.cipher.open<{ evidence: string }>({ context: row.evidence_context,
        keyVersion: row.evidence_key_version, nonce: row.evidence_nonce, ciphertext: row.evidence_ciphertext,
        authTag: row.evidence_auth_tag }).evidence, recordedBy: row.recorded_by, recordedAt: row.recorded_at,
      holds: holds.map((hold) => ({ id: hold.id, action: hold.action, reviewOn: hold.review_on,
        ...open<{ authority: string; reason: string }>(this.cipher, hold), recordedBy: hold.recorded_by,
        recordedAt: hold.recorded_at })) };
  }
  private mapDisposal(row: Awaited<ReturnType<HrCasesRetentionRepository['listDisposals']>>[number]) {
    return { id: row.id, scheduleId: row.schedule_id, personId: row.person_id, category: row.category,
      ruleVersion: row.rule_version, governingRule: row.governing_rule, state: row.state,
      preparedBy: row.prepared_by, preparedAt: row.prepared_at, completedBy: row.completed_by,
      completedAt: row.completed_at, recordCount: row.record_count };
  }
  private openExport(row: ExportRow) {
    const json = open<{ json: string }>(this.cipher, row).json, body = Buffer.from(json, 'utf8');
    if (!createHash('sha256').update(body).digest().equals(row.sha256)) throw new Error('HR export integrity check failed');
    return body;
  }
  private change<T>(work: () => Promise<T>): Promise<HrChange<T>> {
    return work().then((value) => ({ outcome: 'changed' as const, value })).catch((error: unknown) => outcome(error));
  }
  private log(action: string, type: string, id: string, metadata: Record<string, string | number>,
    by: HrActor, executor?: Kysely<Database>) {
    return this.audit.record({ actor: by.actor, action, outcome: 'success', resource: { type, id },
      metadata, ...by.context }, executor);
  }
}

function open<T>(cipher: HrDataCipher, row: { context: string; key_version: number; nonce: Buffer;
  ciphertext: Buffer; auth_tag: Buffer }): T {
  return cipher.open<T>({ context: row.context, keyVersion: row.key_version, nonce: row.nonce,
    ciphertext: row.ciphertext, authTag: row.auth_tag });
}
function openOptional<T>(cipher: HrDataCipher, context: string | null, keyVersion: number | null,
  nonce: Buffer | null, ciphertext: Buffer | null, authTag: Buffer | null): T | null {
  return context && keyVersion && nonce && ciphertext && authTag ? cipher.open<T>({ context, keyVersion, nonce, ciphertext, authTag }) : null;
}
function outcome(error: unknown): HrChange<never> {
  if (error instanceof MissingRecord || ['P0002','23503','42501'].some((code) => hasCode(error, code))) return { outcome: 'not_found' };
  if (['23505','23514','22007','22P02'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
  throw error;
}
function hidden(error: unknown) { return ['P0002','23503','42501'].some((code) => hasCode(error, code)); }
function hasCode(error: unknown, code: string) { return error instanceof Error && 'code' in error && error.code === code; }
class MissingRecord extends Error {}
