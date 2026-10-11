import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ObjectStorage } from '../documents/object-storage.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { ComplianceService, type ComplianceActor } from './compliance.service.js';
import { RestrictedReportsService } from './restricted-reports.service.js';
import { RetentionRepository, type ExportRow, type LegalHoldRow, type RetentionScheduleRow,
  type RestrictedExportRow } from './retention.repository.js';
import type { DisposalRun, RegulatoryExportSummary, RetentionSchedule } from './retention.js';
import { SanctionsRepository } from './sanctions.repository.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';

const MAX_EXPORT_BYTES = 9_900_000;
type Change<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };

@Injectable()
export class RetentionService {
  constructor(private readonly records: RetentionRepository, private readonly compliance: ComplianceService,
    private readonly sanctions: SanctionsRepository, private readonly reports: RestrictedReportsService,
    private readonly cipher: ComplianceDataCipher, private readonly suspicionCipher: SuspicionDataCipher,
    private readonly storage: ObjectStorage, private readonly audit: AuditService) {}

  access(actorId: string) { return this.records.access(actorId); }
  clientChoices(actorId: string) { return this.records.clientChoices(actorId); }
  listSchedules(actorId: string) { return this.records.listSchedules(actorId); }
  listDisposals(actorId: string) { return this.records.listDisposals(actorId); }

  async createSchedule(input: { clientId: string; relationshipEndedOn: string; retentionYears: number;
    governingRule: string; evidence: string }, by: ComplianceActor): Promise<Change<RetentionSchedule>> {
    try {
      const id = await this.records.transaction(async (trx) => {
        const scheduleId = await this.records.newId(trx);
        await this.records.createSchedule({ id: scheduleId, clientId: input.clientId,
          endedOn: input.relationshipEndedOn, years: input.retentionYears, rule: input.governingRule,
          sealed: this.cipher.seal({ evidence: input.evidence }, `aml-retention-schedule:${scheduleId}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.retention_scheduled', outcome: 'success',
          resource: { type: 'aml_retention_schedule', id: scheduleId },
          metadata: { clientId: input.clientId }, ...by.context }, trx);
        return scheduleId;
      });
      return { outcome: 'changed', value: (await this.findSchedule(id, by.accountId))! };
    } catch (error) { return outcome(error); }
  }

  async findSchedule(id: string, actorId: string): Promise<RetentionSchedule | undefined> {
    return this.records.transaction(async (trx) => {
      const row = await this.records.schedule(id, actorId, trx);
      if (!row) return undefined;
      const holds = await this.records.holds(id, actorId, trx);
      return this.openSchedule(row, holds);
    });
  }

  async addHold(scheduleId: string, input: { action: LegalHoldRow['action']; reviewOn: string | null;
    authority: string; reason: string }, by: ComplianceActor): Promise<Change<RetentionSchedule>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.addHold({ id, scheduleId, action: input.action, reviewOn: input.reviewOn,
          sealed: this.cipher.seal({ authority: input.authority, reason: input.reason }, `aml-legal-hold:${id}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: `aml.legal_hold_${input.action}`, outcome: 'success',
          resource: { type: 'aml_retention_schedule', id: scheduleId }, metadata: {}, ...by.context }, trx);
      });
      const value = await this.findSchedule(scheduleId, by.accountId);
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return outcome(error); }
  }

  async dispose(scheduleId: string, by: ComplianceActor): Promise<Change<DisposalRun>> {
    try {
      const proposedId = await this.records.newId();
      const preparedId = await this.records.transaction(async (trx) => {
        const prepared = await this.records.prepareDisposal(proposedId, scheduleId, by.accountId, trx);
        if (!prepared) return undefined;
        for (const key of prepared.objectKeys) await this.storage.remove(key);
        const count = await this.records.finalizeDisposal(prepared.id, by.accountId, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.record_disposed', outcome: 'success',
          resource: { type: 'aml_disposal_run', id: prepared.id }, metadata: { count }, ...by.context }, trx);
        return prepared.id;
      });
      if (!preparedId) return { outcome: 'conflict' };
      const value = (await this.records.listDisposals(by.accountId)).find((item) => item.id === preparedId);
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return outcome(error); }
  }

  async createExport(clientId: string, reason: string, by: ComplianceActor): Promise<Change<RegulatoryExportSummary>> {
    try {
      const bundle = await this.ordinaryBundle(clientId, reason, by.accountId);
      const json = JSON.stringify(bundle, null, 2);
      const bytes = Buffer.from(json, 'utf8');
      if (bytes.length > MAX_EXPORT_BYTES) return { outcome: 'conflict' };
      const hash = createHash('sha256').update(bytes).digest();
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.createExport({ id, clientId, sealed: this.cipher.seal({ json }, `aml-export:${id}`),
          sha256: hash, byteSize: bytes.length, actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.exported', outcome: 'success',
          resource: { type: 'aml_export', id }, metadata: { clientId, byteSize: bytes.length }, ...by.context }, trx);
        const row = await this.records.export(id, by.accountId, trx);
        return row && summary(row);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return outcome(error); }
  }

  async listExports(actorId: string): Promise<RegulatoryExportSummary[]> {
    return (await this.records.listExports(actorId)).map((r) => ({ id: r.id, clientId: r.client_id,
      sha256: r.sha256.toString('hex'), byteSize: r.byte_size, createdBy: r.created_by, createdAt: r.created_at }));
  }

  async downloadExport(id: string, by: ComplianceActor) {
    return this.records.transaction(async (trx) => {
      const row = await this.records.export(id, by.accountId, trx);
      if (!row) return undefined;
      await this.audit.record({ actor: by.actor, action: 'aml.export_downloaded', outcome: 'success',
        resource: { type: 'aml_export', id }, metadata: {}, ...by.context }, trx);
      const json = this.cipher.open<{ json: string }>(sealed(row)).json;
      const body = Buffer.from(json, 'utf8');
      if (!createHash('sha256').update(body).digest().equals(row.sha256)) throw new Error('AML export integrity check failed');
      return { body, sha256: row.sha256.toString('hex'), createdAt: row.created_at };
    });
  }

  async createRestrictedExport(reportId: string, reason: string, by: ComplianceActor) {
    try {
      const report = await this.reports.find(reportId, by.accountId);
      if (!report) return { outcome: 'not_found' as const };
      const json = JSON.stringify({ schemaVersion: 1, kind: 'restricted_suspicion_report', reason, report }, null, 2);
      const bytes = Buffer.from(json, 'utf8');
      if (bytes.length > MAX_EXPORT_BYTES) return { outcome: 'conflict' as const };
      const hash = createHash('sha256').update(bytes).digest();
      const id = await this.records.transaction(async (trx) => {
        const exportId = await this.records.newId(trx);
        await this.records.createRestrictedExport({ id: exportId, reportId,
          sealed: this.suspicionCipher.seal({ json }, `suspicion-export:${exportId}`), sha256: hash,
          byteSize: bytes.length, actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'compliance.restricted_record_changed', outcome: 'success',
          resource: { type: 'compliance_restricted_record', id: reportId }, metadata: {}, ...by.context }, trx);
        return exportId;
      });
      return { outcome: 'changed' as const, value: { id, reportId, sha256: hash.toString('hex'), byteSize: bytes.length } };
    } catch (error) { return outcome(error); }
  }

  async downloadRestrictedExport(reportId: string, id: string, actorId: string) {
    const row = await this.records.restrictedExport(reportId, id, actorId);
    if (!row) return undefined;
    const json = this.suspicionCipher.open<{ json: string }>(sealedRestricted(row)).json;
    const body = Buffer.from(json, 'utf8');
    if (!createHash('sha256').update(body).digest().equals(row.sha256)) throw new Error('Restricted export integrity check failed');
    return { body, sha256: row.sha256.toString('hex'), createdAt: row.created_at };
  }

  private async ordinaryBundle(clientId: string, reason: string, actorId: string) {
    const cddCases: unknown[] = [];
    let cddBefore: string | undefined;
    do {
      const page = await this.compliance.listCdd(clientId, actorId, cddBefore);
      if (!page) throw new MissingExportSource();
      cddCases.push(...page.items);
      cddBefore = page.next ?? undefined;
    } while (cddBefore);

    const matters: unknown[] = [];
    for (const matterId of await this.records.matterIds(clientId)) {
      const assessments: unknown[] = [];
      let before: string | undefined;
      do {
        const page = await this.compliance.listRiskAssessments(matterId, actorId, before);
        if (!page) throw new MissingExportSource();
        for (const assessment of page.items) {
          assessments.push({ assessment,
            work: await this.compliance.findAssessmentWork(matterId, assessment.id, actorId),
            clearance: await this.compliance.findClearance(matterId, assessment.id, actorId) });
        }
        before = page.next ?? undefined;
      } while (before);
      matters.push({ matterId, assessments });
    }
    const holds: unknown[] = [];
    for (const id of await this.records.holdIds(clientId)) {
      const hold = await this.compliance.findHold(id);
      if (hold) holds.push(hold);
    }
    const [state, licences, frozenFunds] = await Promise.all([
      this.sanctions.sanctionsState(clientId), this.sanctions.licences(clientId), this.sanctions.frozenFunds(clientId),
    ]);
    return { schemaVersion: 1, kind: 'ordinary_aml', clientId, reason, cddCases, matters, holds,
      sanctions: { state, licences, frozenFunds } };
  }

  private openSchedule(row: RetentionScheduleRow, holdRows: LegalHoldRow[]): RetentionSchedule {
    return { id: row.id, clientId: row.client_id, relationshipEndedOn: row.relationship_ended_on,
      retentionYears: row.retention_years, disposeAfter: row.dispose_after, governingRule: row.governing_rule,
      evidence: this.cipher.open<{ evidence: string }>({ context: row.evidence_context,
        keyVersion: row.evidence_key_version, nonce: row.evidence_nonce, ciphertext: row.evidence_ciphertext,
        authTag: row.evidence_auth_tag }).evidence,
      recordedBy: row.recorded_by, recordedAt: row.recorded_at,
      holds: holdRows.map((h) => ({ id: h.id, action: h.action, reviewOn: h.review_on,
        ...this.cipher.open<{ authority: string; reason: string }>(sealed(h)),
        recordedBy: h.recorded_by, recordedAt: h.recorded_at })) };
  }
}

function sealed(row: { encryption_context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer }) {
  return { context: row.encryption_context, keyVersion: row.key_version, nonce: row.nonce,
    ciphertext: row.ciphertext, authTag: row.auth_tag };
}
function sealedRestricted(row: RestrictedExportRow) { return sealed(row); }
function summary(row: ExportRow): RegulatoryExportSummary {
  return { id: row.id, clientId: row.client_id, sha256: row.sha256.toString('hex'), byteSize: row.byte_size,
    createdBy: row.created_by, createdAt: row.created_at };
}
function outcome(error: unknown): Change<never> {
  if (error instanceof MissingExportSource || hasCode(error, 'P0002') || hasCode(error, '23503') || hasCode(error, '42501')) return { outcome: 'not_found' };
  if (['23505', '23514', '22007', '22P02'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
  throw error;
}
class MissingExportSource extends Error {}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
