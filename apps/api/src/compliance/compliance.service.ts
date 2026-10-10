import { createHash } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActor } from '../audit/audit-event.js';
import type { RequestContext } from '../common/http/request-context.js';
import { sql, type Kysely } from 'kysely';
import { text } from '../common/validation/safe-text.js';
import type {
  AmlControlKind, AmlExpectedValue, AmlMeasureKind, AmlOfficerKind, AmlOutcome, AmlRiskRating, AmlSubjectKind, AmlSubjectRelationship, Database, DocumentMediaType,
} from '../database/schema.js';
import { FileInspection, FileRefusedError, type RefusalReason } from '../documents/file-inspection.js';
import { UploadFormError } from '../documents/upload-request.js';
import { isLimitsAlert, VirusScanner } from '../documents/virus-scanner.js';
import { AmlEvidenceVault, type StoredAmlEvidence } from './aml-evidence-vault.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { ComplianceRepository } from './compliance.repository.js';
import type {
  AssessmentWork, CddCase, Clearance, Gate, CddSubjectDetails, ControlVersion, CountryListVersion, IndependentReview, OfficerAppointment,
  RiskAssessment, RiskFactors, RiskNarrative, TrainingCompletion,
} from './compliance.js';

export interface ComplianceActor { actor: AuditActor; accountId: string; context?: RequestContext }
export type Change<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' } | { outcome: 'conflict' };
const COMPLIANCE_PAGE_SIZE = 100;
export const AML_EVIDENCE_UPLOADS_PER_HOUR = 200;
export const AML_EVIDENCE_BYTES_PER_HOUR = 2 * 1024 ** 3;
const AML_EVIDENCE_WINDOW_SECONDS = 60 * 60;
const evidenceFileName = text(255);

class AmlEvidenceAllowanceError extends Error {}
class CddSubmittedError extends Error {}

type ReceiveRefusal = RefusalReason | 'malware' | 'scanner_unavailable' | 'unscannable' | 'form' | 'interrupted';
export type EvidenceOutcome =
  | { outcome: 'added'; value: CddCase }
  | { outcome: 'not_found' | 'conflict' }
  | { outcome: 'refused'; reason: ReceiveRefusal | 'over_allowance' | 'file_name' };
interface ReceivedEvidence {
  inspected: { mediaType: DocumentMediaType; sizeBytes: number; sha256: Buffer };
  stored: StoredAmlEvidence;
}

export interface EvidenceInput {
  evidenceType: string; country: string | null; issuedOn: string | null; expiresOn: string | null;
  documentIdentifier: string | null; providerPayloadHash: string | null; fileName: string; file: Readable;
}
export interface OwnershipInput {
  ownedSubjectId: string; controllerSubjectId: string; ownershipPercent: string | null; controlKind: string; details: string;
}
export interface AuthorityInput {
  representativeSubjectId: string; representedSubjectId: string; evidenceId: string;
  authorityType: string; verifiedOn: string; details: string;
}
export interface VerificationInput {
  subjectId: string; evidenceId: string; sourceType: string; country: string | null; checkedOn: string;
  expiresOn: string | null; method: string; outcome: string; provider: string | null; service: string | null;
  documentIdentifier: string | null; providerResult: string | null; reliance: Record<string, unknown> | null;
}

function page<T extends { id: string }>(items: T[]): { items: T[]; next: string | null } {
  return { items, next: items.length === COMPLIANCE_PAGE_SIZE ? items.at(-1)!.id : null };
}

@Injectable()
export class ComplianceService {
  constructor(private readonly records: ComplianceRepository, private readonly audit: AuditService,
    private readonly cipher: ComplianceDataCipher, private readonly evidenceVault: AmlEvidenceVault,
    private readonly scanner: VirusScanner) {}

  async listAppointments(before?: string) { return page(await this.records.listAppointments(before)); }

  async appoint(accountId: string, kind: AmlOfficerKind, by: ComplianceActor): Promise<Change<OfficerAppointment>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.appoint(accountId, kind, by.accountId, trx);
        const appointment = await this.records.findAppointment(id, trx);
        if (!appointment) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.officer_appointed', outcome: 'success',
          resource: { type: 'aml_officer_appointment', id }, metadata: { accountId, kind }, ...by.context }, trx);
        return appointment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async endAppointment(id: string, reason: string, by: ComplianceActor): Promise<Change<OfficerAppointment>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.endAppointment(id, reason, by.accountId, trx);
        const appointment = await this.records.findAppointment(id, trx);
        if (!appointment) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.officer_appointment_ended', outcome: 'success',
          resource: { type: 'aml_officer_appointment', id }, metadata: { kind: appointment.kind }, ...by.context }, trx);
        return appointment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listControls(pendingOnly = false, before?: string) { return page(await this.records.listControls(pendingOnly, before)); }
  findControl(id: string) { return this.records.findControl(id); }

  async createControl(input: {
    kind: AmlControlKind; title: string; content: string; source: string;
    effectiveFrom: string; reviewDueOn: string;
  }, by: ComplianceActor): Promise<Change<ControlVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const hash = createHash('sha256').update(input.content, 'utf8').digest();
        const id = await this.records.createControl({ ...input, hash, actorId: by.accountId }, trx);
        const control = await this.records.findControl(id, trx);
        if (!control) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.control_published', outcome: 'success',
          resource: { type: 'aml_control_version', id }, metadata: { kind: control.kind, version: control.version }, ...by.context }, trx);
        return control;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async approveControl(id: string, by: ComplianceActor): Promise<Change<ControlVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.approveControl(id, by.accountId, trx);
        const control = await this.records.findControl(id, trx);
        if (!control) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.control_approved', outcome: 'success',
          resource: { type: 'aml_control_version', id }, metadata: { kind: control.kind, version: control.version }, ...by.context }, trx);
        return control;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return databaseOutcome(error); }
  }

  async recordTraining(input: {
    accountId: string; materialId: string; provider: string; completedOn: string; evidenceReference: string;
  }, by: ComplianceActor): Promise<Change<TrainingCompletion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.recordTraining({ ...input, actorId: by.accountId }, trx);
        const completion = await this.records.findTraining(id, trx);
        if (!completion) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.training_recorded', outcome: 'success',
          resource: { type: 'aml_training_completion', id },
          metadata: { accountId: input.accountId, materialId: input.materialId }, ...by.context }, trx);
        return completion;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listTraining(accountId?: string, before?: string) { return page(await this.records.listTraining(accountId, before)); }

  async recordReview(input: {
    periodStart: string; periodEnd: string; completedOn: string; reviewerName: string;
    reviewerOrganisation: string | null; independenceBasis: string; scope: string;
    findings: string; recommendations: string; managementResponse: string;
  }, by: ComplianceActor): Promise<Change<IndependentReview>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.recordReview({ ...input, actorId: by.accountId }, trx);
        const review = await this.records.findReview(id, trx);
        if (!review) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.independent_review_recorded', outcome: 'success',
          resource: { type: 'aml_independent_review', id },
          metadata: { periodStart: input.periodStart, periodEnd: input.periodEnd }, ...by.context }, trx);
        return review;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listReviews(before?: string) { return page(await this.records.listReviews(before)); }

  async createCdd(clientId: string, input: { intendedRelationship: string; reason: string }, by: ComplianceActor): Promise<Change<CddCase>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.createCdd(clientId, input.intendedRelationship, input.reason, by.accountId, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.cdd_draft_created', outcome: 'success',
          resource: { type: 'aml_cdd_case', id }, metadata: { clientId }, ...by.context }, trx);
        return this.records.findCdd(clientId, id, by.accountId, true, trx);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return protectedOutcome(error); }
  }

  async listCdd(clientId: string, actorId: string, before?: string) {
    try {
      return page(await this.records.listCdd(clientId, actorId, before));
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  async findCdd(clientId: string, caseId: string, actorId: string) {
    try {
      return await this.records.findCdd(clientId, caseId, actorId);
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  addSubject(clientId: string, caseId: string, input: {
    kind: AmlSubjectKind; relationship: AmlSubjectRelationship; details: CddSubjectDetails;
  }, by: ComplianceActor): Promise<Change<CddCase>> {
    return this.addDraftFact(clientId, caseId, by, async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addSubject({ id, caseId, kind: input.kind, relationship: input.relationship,
        sealed: this.cipher.seal(input.details, `aml-subject:${id}`), actorId: by.accountId }, trx);
    });
  }

  addOwnership(clientId: string, caseId: string, input: OwnershipInput, by: ComplianceActor): Promise<Change<CddCase>> {
    return this.addDraftFact(clientId, caseId, by, async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addOwnership({ ...input, id, caseId,
        sealed: this.cipher.seal({ details: input.details }, `aml-ownership:${id}`), actorId: by.accountId }, trx);
    });
  }

  addAuthority(clientId: string, caseId: string, input: AuthorityInput, by: ComplianceActor): Promise<Change<CddCase>> {
    return this.addDraftFact(clientId, caseId, by, async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addAuthority({ ...input, id, caseId,
        sealed: this.cipher.seal({ details: input.details }, `aml-authority:${id}`), actorId: by.accountId }, trx);
    });
  }

  addVerification(clientId: string, caseId: string, input: VerificationInput, by: ComplianceActor): Promise<Change<CddCase>> {
    return this.addDraftFact(clientId, caseId, by, async (trx) => {
      const id = await this.records.newId(trx);
      const { documentIdentifier, providerResult, reliance, ...safe } = input;
      await this.records.addVerification({ ...safe, id, caseId,
        sealed: this.cipher.seal({ documentIdentifier, providerResult, reliance }, `aml-verification:${id}`),
        actorId: by.accountId }, trx);
    });
  }

  /** Runs one write against a live draft and returns the case as it now stands. */
  private async addDraftFact(clientId: string, caseId: string, by: ComplianceActor,
    write: (trx: Kysely<Database>) => Promise<void>): Promise<Change<CddCase>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        if (!await this.isDraft(clientId, caseId, by, trx)) return undefined;
        await write(trx);
        return this.records.findCdd(clientId, caseId, by.accountId, true, trx);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  /** False when the case does not exist; throws when it exists but is no longer a draft. */
  private async isDraft(clientId: string, caseId: string, by: ComplianceActor, trx: Kysely<Database>): Promise<boolean> {
    const status = await this.records.cddStatus(clientId, caseId, by.accountId, trx);
    if (!status) return false;
    if (status !== 'draft') throw new CddSubmittedError();
    return true;
  }

  async addEvidence(clientId: string, caseId: string, input: EvidenceInput, by: ComplianceActor): Promise<EvidenceOutcome> {
    const skip = (result: EvidenceOutcome): EvidenceOutcome => {
      input.file.resume();
      return result;
    };
    try {
      const status = await this.records.cddStatus(clientId, caseId, by.accountId);
      if (!status) return skip({ outcome: 'not_found' });
      if (status !== 'draft') return skip({ outcome: 'conflict' });
    } catch (error) {
      if (hiddenRecord(error)) return skip({ outcome: 'not_found' });
      throw error;
    }
    const checkedName = evidenceFileName.safeParse(input.fileName);
    if (!checkedName.success) return skip({ outcome: 'refused', reason: 'file_name' });
    const fileName = checkedName.data;
    if (!await this.withinEvidenceAllowance(by.accountId, 0)) return skip({ outcome: 'refused', reason: 'over_allowance' });

    const received = await this.receiveEvidence(fileName, input.file);
    if ('reason' in received) {
      await this.audit.record({ actor: by.actor, action: 'aml.evidence_refused', outcome: 'failure',
        resource: { type: 'aml_cdd_case', id: caseId }, metadata: { reason: received.reason }, ...by.context });
      return { outcome: 'refused', reason: received.reason };
    }

    try {
      const value = await this.records.transaction(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`app.aml_evidence_uploads:${by.accountId}`}, 0))`.execute(trx);
        if (!await this.withinEvidenceAllowance(by.accountId, received.inspected.sizeBytes, trx)) throw new AmlEvidenceAllowanceError();
        const id = await this.records.newId(trx);
        await this.records.addEvidence({
          id, caseId, evidenceType: input.evidenceType, country: input.country,
          issuedOn: input.issuedOn, expiresOn: input.expiresOn,
          metadata: this.cipher.seal({ fileName, documentIdentifier: input.documentIdentifier,
            providerPayloadHash: input.providerPayloadHash }, `aml-evidence-metadata:${id}`),
          mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes, sha256: received.inspected.sha256,
          storageKey: received.stored.storageKey, fileKey: received.stored.sealedKey,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.evidence_uploaded', outcome: 'success',
          resource: { type: 'aml_cdd_evidence', id },
          metadata: { caseId, mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes }, ...by.context }, trx);
        return this.records.findCdd(clientId, caseId, by.accountId, true, trx);
      });
      if (!value) {
        await this.evidenceVault.discard(received.stored.storageKey);
        return { outcome: 'not_found' };
      }
      return { outcome: 'added', value };
    } catch (error) {
      await this.evidenceVault.discard(received.stored.storageKey);
      if (error instanceof AmlEvidenceAllowanceError) {
        await this.audit.record({ actor: by.actor, action: 'aml.evidence_upload_limited', outcome: 'denied',
          metadata: { files: AML_EVIDENCE_UPLOADS_PER_HOUR, bytes: AML_EVIDENCE_BYTES_PER_HOUR }, ...by.context });
        return { outcome: 'refused', reason: 'over_allowance' };
      }
      return { outcome: protectedOutcome(error).outcome === 'not_found' ? 'not_found' : 'conflict' };
    }
  }

  private async withinEvidenceAllowance(accountId: string, sizeBytes: number, trx?: Kysely<Database>): Promise<boolean> {
    const totals = await this.audit.recentTotals({ actorId: accountId, actions: ['aml.evidence_uploaded'],
      seconds: AML_EVIDENCE_WINDOW_SECONDS, field: 'sizeBytes' }, trx);
    return totals.count + 1 <= AML_EVIDENCE_UPLOADS_PER_HOUR && totals.total + sizeBytes <= AML_EVIDENCE_BYTES_PER_HOUR;
  }

  async submitCdd(clientId: string, caseId: string, by: ComplianceActor): Promise<Change<CddCase>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        if (!await this.isDraft(clientId, caseId, by, trx)) return undefined;
        await this.records.submitCdd(caseId, by.accountId, trx);
        const item = await this.records.findCdd(clientId, caseId, by.accountId, true, trx);
        if (!item) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.cdd_submitted', outcome: 'success',
          resource: { type: 'aml_cdd_case', id: caseId },
          metadata: { clientId, version: item.version, subjects: item.subjects.length, evidence: item.evidence.length }, ...by.context }, trx);
        return item;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  async abandonCdd(clientId: string, caseId: string, reason: string, by: ComplianceActor): Promise<Change<CddCase>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        if (!await this.isDraft(clientId, caseId, by, trx)) return undefined;
        await this.records.abandonCdd(caseId, reason, by.accountId, trx);
        const item = await this.records.findCdd(clientId, caseId, by.accountId, true, trx);
        if (!item) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.cdd_draft_abandoned', outcome: 'success',
          resource: { type: 'aml_cdd_case', id: caseId }, metadata: { clientId, version: item.version }, ...by.context }, trx);
        return item;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  async downloadEvidence(clientId: string, caseId: string, evidenceId: string, by: ComplianceActor) {
    try {
      const found = await this.records.evidenceForDownload(clientId, caseId, evidenceId, by.accountId);
      if (!found) return { outcome: 'not_found' } as const;
      const file = await this.evidenceVault.open({ storageKey: found.storageKey, sealedKey: found.sealedKey });
      await this.audit.record({ actor: by.actor, action: 'aml.evidence_viewed', outcome: 'success',
        resource: { type: 'aml_cdd_evidence', id: evidenceId }, metadata: { caseId }, ...by.context });
      return { outcome: 'ready', file, fileName: found.fileName, mediaType: found.mediaType, sizeBytes: found.sizeBytes } as const;
    } catch (error) {
      if (hiddenRecord(error)) return { outcome: 'not_found' } as const;
      throw error;
    }
  }

  async listCountryLists(pendingOnly: boolean, before?: string) {
    return page(await this.records.listCountryLists(pendingOnly, before));
  }

  findCountryList(id: string) { return this.records.findCountryList(id); }

  async createCountryList(input: { countries: string[]; source: string; effectiveFrom: string },
    by: ComplianceActor): Promise<Change<CountryListVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.createCountryList({ ...input, actorId: by.accountId }, trx);
        const list = await this.records.findCountryList(id, trx);
        if (!list) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.country_list_published', outcome: 'success',
          resource: { type: 'aml_country_list_version', id },
          metadata: { version: list.version, countries: list.countries.length }, ...by.context }, trx);
        return list;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async approveCountryList(id: string, by: ComplianceActor): Promise<Change<CountryListVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.approveCountryList(id, by.accountId, trx);
        const list = await this.records.findCountryList(id, trx);
        if (!list) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.country_list_approved', outcome: 'success',
          resource: { type: 'aml_country_list_version', id }, metadata: { version: list.version }, ...by.context }, trx);
        return list;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return databaseOutcome(error); }
  }

  async submitRiskAssessment(matterId: string, input: {
    inScope: boolean; rating: AmlRiskRating; factors: RiskFactors; jurisdictions: string[];
    expectedValue: AmlExpectedValue; reviewDueOn: string; reviewGraceDays: number; narrative: RiskNarrative;
  }, by: ComplianceActor): Promise<Change<RiskAssessment>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        const { narrative, ...facts } = input;
        await this.records.submitRiskAssessment({ ...facts, id, matterId,
          loweringGroundsGiven: narrative.loweringGrounds !== null,
          sealed: this.cipher.seal(narrative, `aml-risk:${id}`), actorId: by.accountId }, trx);
        const assessment = await this.records.findRiskAssessment(matterId, id, by.accountId, true, trx);
        if (!assessment) return undefined;
        // The rating is left out: it can reveal PEP or high-risk-country status.
        await this.audit.record({ actor: by.actor, action: 'aml.risk_submitted', outcome: 'success',
          resource: { type: 'aml_risk_assessment', id },
          metadata: { matterId, version: assessment.version }, ...by.context }, trx);
        return assessment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  async listRiskAssessments(matterId: string, actorId: string, before?: string) {
    try {
      return page(await this.records.listRiskAssessments(matterId, actorId, before));
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  async findRiskAssessment(matterId: string, assessmentId: string, actorId: string) {
    try {
      return await this.records.findRiskAssessment(matterId, assessmentId, actorId);
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  async findAssessmentWork(matterId: string, assessmentId: string, actorId: string) {
    try {
      return await this.records.findAssessmentWork(matterId, assessmentId, actorId);
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  addMeasure(matterId: string, assessmentId: string, input: { kind: AmlMeasureKind; description: string },
    by: ComplianceActor): Promise<Change<AssessmentWork>> {
    return this.changeWork(matterId, assessmentId, null, 'aml.measure_added', by, async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.addMeasure({ id, assessmentId, kind: input.kind,
        sealed: this.cipher.seal({ text: input.description }, `aml-measure:${id}`), actorId: by.accountId }, trx);
    });
  }

  recordMeasureResult(matterId: string, assessmentId: string, measureId: string,
    input: { outcome: AmlOutcome; evidenceIds: string[]; reasoning: string }, by: ComplianceActor): Promise<Change<AssessmentWork>> {
    return this.changeWork(matterId, assessmentId, measureId, 'aml.measure_result_recorded', by, async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordMeasureResult({ id, measureId, outcome: input.outcome, evidenceIds: input.evidenceIds,
        sealed: this.cipher.seal({ text: input.reasoning }, `aml-measure-result:${id}`), actorId: by.accountId }, trx);
    });
  }

  recordSourceConclusion(matterId: string, assessmentId: string, input: {
    kind: 'funds' | 'wealth'; subjectId: string | null; amountMinPence: string; amountMaxPence: string;
    outcome: AmlOutcome; evidenceIds: string[]; reasoning: string;
  }, by: ComplianceActor): Promise<Change<AssessmentWork>> {
    return this.changeWork(matterId, assessmentId, null, 'aml.source_conclusion_recorded', by, async (trx) => {
      const id = await this.records.newId(trx);
      const { reasoning, ...facts } = input;
      await this.records.recordSourceConclusion({ ...facts, id, assessmentId,
        sealed: this.cipher.seal({ text: reasoning }, `aml-source:${id}`), actorId: by.accountId }, trx);
    });
  }

  async findClearance(matterId: string, assessmentId: string, actorId: string): Promise<Clearance | null | undefined> {
    try {
      await this.records.assertMatterAccess(matterId, actorId);
      if (!await this.records.workBelongs(matterId, assessmentId, null)) return undefined;
      return (await this.records.findClearance(matterId, assessmentId)) ?? null;
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  async decideClearance(matterId: string, assessmentId: string, input: { decision: 'approved' | 'refused'; reasoning: string },
    by: ComplianceActor): Promise<Change<Clearance>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.assertMatterAccess(matterId, by.accountId, trx);
        if (!await this.records.workBelongs(matterId, assessmentId, null, trx)) return undefined;
        const id = await this.records.newId(trx);
        await this.records.decideClearance({ id, assessmentId, decision: input.decision,
          sealed: this.cipher.seal({ text: input.reasoning }, `aml-clearance:${id}`), actorId: by.accountId }, trx);
        const clearance = await this.records.findClearance(matterId, assessmentId, trx);
        if (!clearance) return undefined;
        await this.audit.record({ actor: by.actor,
          action: input.decision === 'approved' ? 'aml.clearance_approved' : 'aml.clearance_refused', outcome: 'success',
          resource: { type: 'aml_clearance', id }, metadata: { matterId, assessmentId }, ...by.context }, trx);
        return clearance;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  /** Senior-management approval is firm-wide: a Partner approves without needing to be on the matter. */
  async approveSenior(matterId: string, assessmentId: string, by: ComplianceActor): Promise<Change<Clearance>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const clearance = await this.records.findClearance(matterId, assessmentId, trx);
        if (!clearance) return undefined;
        await this.records.approveSenior(clearance.id, by.accountId, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.senior_approval_given', outcome: 'success',
          resource: { type: 'aml_clearance', id: clearance.id }, metadata: { matterId, assessmentId }, ...by.context }, trx);
        return this.records.findClearance(matterId, assessmentId, trx);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  async gate(matterId: string, actorId: string): Promise<Gate | undefined> {
    try {
      await this.records.assertMatterAccess(matterId, actorId);
      return await this.records.gate(matterId);
    } catch (error) {
      if (hiddenRecord(error)) return undefined;
      throw error;
    }
  }

  /**
   * Runs one write against an assessment named under its matter and returns the work as it now stands.
   * Audit metadata holds ids only: even a measure's kind can hint at PEP or high-risk status.
   */
  private async changeWork(matterId: string, assessmentId: string, measureId: string | null, action: string,
    by: ComplianceActor, write: (trx: Kysely<Database>) => Promise<void>): Promise<Change<AssessmentWork>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.assertMatterAccess(matterId, by.accountId, trx);
        if (!await this.records.workBelongs(matterId, assessmentId, measureId, trx)) return undefined;
        await write(trx);
        const work = await this.records.findAssessmentWork(matterId, assessmentId, by.accountId, true, trx);
        if (!work) return undefined;
        await this.audit.record({ actor: by.actor, action, outcome: 'success',
          resource: { type: 'aml_risk_assessment', id: assessmentId }, metadata: { matterId }, ...by.context }, trx);
        return work;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return protectedOutcome(error); }
  }

  /**
   * Streams one upload through inspection into the scanner and the vault at once.
   * The first failure stops every branch, and a refused or failed file is removed from storage.
   */
  private async receiveEvidence(fileName: string, file: Readable): Promise<ReceivedEvidence | { reason: ReceiveRefusal }> {
    const inspection = new FileInspection(fileName);
    const toScanner = new PassThrough();
    const toVault = new PassThrough();
    let first: { origin: 'file' | 'inspection' | 'scanner' | 'storage'; error: unknown } | undefined;
    const stop = (origin: NonNullable<typeof first>['origin']) => (error: unknown) => {
      first ??= { origin, error };
      const reason = error instanceof Error ? error : new Error('Upload stopped');
      inspection.destroy(reason);
      toScanner.destroy(reason);
      toVault.destroy(reason);
    };
    file.on('error', stop('file'));
    inspection.on('error', stop('inspection'));
    toScanner.on('error', () => undefined);
    toVault.on('error', () => undefined);
    if (file.destroyed) stop('file')(file.errored ?? new Error('The upload was interrupted'));
    file.pipe(inspection);
    inspection.pipe(toScanner);
    inspection.pipe(toVault);

    const scanning = this.scanner.scan(toScanner);
    const storing = this.evidenceVault.store(toVault);
    scanning.catch(stop('scanner'));
    storing.catch(stop('storage'));
    const [scan, store] = await Promise.allSettled([scanning, storing]);

    let reason: ReceiveRefusal | undefined;
    if (first?.origin === 'inspection' && first.error instanceof FileRefusedError) reason = first.error.reason;
    else if (first?.origin === 'scanner') reason = 'scanner_unavailable';
    else if (first?.origin === 'file') reason = first.error instanceof UploadFormError ? 'form' : 'interrupted';
    else if (!first && scan.status === 'fulfilled' && !scan.value.clean) reason = isLimitsAlert(scan.value.signature) ? 'unscannable' : 'malware';

    if (reason || first) {
      if (store.status === 'fulfilled') await this.evidenceVault.discard(store.value.storageKey);
      if (reason) return { reason };
      throw first!.error;
    }
    if (scan.status === 'rejected' || store.status === 'rejected') throw new Error('Evidence upload ended without an answer');
    return { inspected: inspection.result(), stored: store.value };
  }
}

/** An unknown client or matter and one the actor may not see both read as "not found". */
function hiddenRecord(error: unknown): boolean {
  return hasCode(error, '42501') || hasCode(error, 'P0002');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Access is checked first, so a refusal hides the record like an unknown id. */
function protectedOutcome<T>(error: unknown): Change<T> {
  return hiddenRecord(error) ? { outcome: 'not_found' } : databaseOutcome(error);
}

function databaseOutcome<T>(error: unknown): Change<T> {
  if (error instanceof CddSubmittedError) return { outcome: 'conflict' };
  if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
  if (['23505', '23514', '42501', '22P02', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
  throw error;
}
