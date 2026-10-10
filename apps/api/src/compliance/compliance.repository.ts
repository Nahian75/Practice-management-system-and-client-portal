import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import { DATABASE } from '../database/database.module.js';
import type {
  AmlCddStatus, AmlControlKind, AmlExpectedValue, AmlMeasureKind, AmlOfficerKind, AmlOutcome, AmlRiskRating, AmlSubjectKind, AmlSubjectRelationship,
  Database, DocumentMediaType,
} from '../database/schema.js';
import { ComplianceDataCipher, type SealedComplianceData } from './compliance-data-cipher.js';
import type {
  AssessmentWork, CddCase, CddSubjectDetails, ControlVersion, CountryListVersion, IndependentReview, OfficerAppointment,
  RiskAssessment, RiskFactors, RiskNarrative, TrainingCompletion,
} from './compliance.js';

/** Must match app.is_enhanced_aml_measure in migration 0051. */
const ENHANCED_MEASURES = new Set<AmlMeasureKind>(['additional_sources', 'ownership_background', 'transaction_reasons',
  'source_of_funds', 'source_of_wealth', 'enhanced_monitoring']);

interface EvidenceMetadata { fileName: string; documentIdentifier: string | null; providerPayloadHash: string | null }
interface VerificationDetails { documentIdentifier: string | null; providerResult: string | null; reliance: Record<string, unknown> | null }

@Injectable()
export class ComplianceRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>, private readonly cipher: ComplianceDataCipher) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async appoint(accountId: string, kind: AmlOfficerKind, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.appoint_aml_officer(${accountId}, ${kind}, ${actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async endAppointment(id: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.end_aml_officer_appointment(${id}, ${reason}, ${actorId})`.execute(trx);
  }

  async findAppointment(id: string, executor: Kysely<Database> = this.db): Promise<OfficerAppointment | undefined> {
    const row = await executor.selectFrom('aml_officer_appointments as o')
      .innerJoin('accounts as target', 'target.id', 'o.account_id')
      .innerJoin('accounts as appointing', 'appointing.id', 'o.appointed_by')
      .leftJoin('accounts as ending', 'ending.id', 'o.ended_by')
      .select(['o.id', 'o.kind', 'o.appointed_at', 'o.ended_at', 'o.end_reason',
        'target.id as account_id', 'target.display_name as account_name',
        'appointing.id as appointed_by_id', 'appointing.display_name as appointed_by_name',
        'ending.id as ended_by_id', 'ending.display_name as ended_by_name'])
      .where('o.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, kind: row.kind,
      account: { accountId: row.account_id, displayName: row.account_name },
      appointedBy: { accountId: row.appointed_by_id, displayName: row.appointed_by_name },
      appointedAt: row.appointed_at, endedAt: row.ended_at, endReason: row.end_reason,
      endedBy: row.ended_by_id && row.ended_by_name
        ? { accountId: row.ended_by_id, displayName: row.ended_by_name } : null,
    };
  }

  async listAppointments(before?: string): Promise<OfficerAppointment[]> {
    let query = this.db.selectFrom('aml_officer_appointments').select('id');
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findAppointment(row.id))))
      .filter((row): row is OfficerAppointment => row !== undefined);
  }

  async createControl(input: {
    kind: AmlControlKind; title: string; content: string; hash: Buffer; source: string;
    effectiveFrom: string; reviewDueOn: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_aml_control_version(
      ${input.kind}, ${input.title}, ${input.content}, ${input.hash}, ${input.source},
      ${input.effectiveFrom}::date, ${input.reviewDueOn}::date, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async approveControl(id: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.approve_aml_control_version(${id}, ${actorId})`.execute(trx);
  }

  async findControl(id: string, executor: Kysely<Database> = this.db): Promise<ControlVersion | undefined> {
    const row = await executor.selectFrom('aml_control_versions as v')
      .innerJoin('accounts as preparer', 'preparer.id', 'v.prepared_by')
      .leftJoin('aml_control_approvals as p', 'p.control_version_id', 'v.id')
      .leftJoin('accounts as approver', 'approver.id', 'p.approved_by')
      .select(['v.id', 'v.kind', 'v.version', 'v.title', 'v.content', 'v.content_sha256', 'v.source',
        'v.effective_from', 'v.review_due_on', 'v.prepared_at', 'preparer.id as prepared_by_id',
        'preparer.display_name as prepared_by_name', 'p.id as approval_id', 'p.approved_at',
        'approver.id as approved_by_id', 'approver.display_name as approved_by_name'])
      .where('v.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, kind: row.kind, version: row.version, title: row.title, content: row.content,
      contentSha256: row.content_sha256.toString('hex'), source: row.source,
      effectiveFrom: row.effective_from, reviewDueOn: row.review_due_on,
      preparedBy: { accountId: row.prepared_by_id, displayName: row.prepared_by_name }, preparedAt: row.prepared_at,
      approval: row.approval_id && row.approved_at && row.approved_by_id && row.approved_by_name
        ? { id: row.approval_id, approvedAt: row.approved_at,
            approvedBy: { accountId: row.approved_by_id, displayName: row.approved_by_name } } : null,
    };
  }

  async listControls(pendingOnly = false, before?: string): Promise<ControlVersion[]> {
    let query = this.db.selectFrom('aml_control_versions as v').leftJoin('aml_control_approvals as p', 'p.control_version_id', 'v.id').select('v.id');
    if (pendingOnly) query = query.where('p.id', 'is', null);
    if (before) query = query.where('v.id', '<', before);
    const rows = await query.orderBy('v.id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findControl(row.id))))
      .filter((row): row is ControlVersion => row !== undefined);
  }

  async recordTraining(input: {
    accountId: string; materialId: string; provider: string; completedOn: string;
    evidenceReference: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_aml_training(
      ${input.accountId}, ${input.materialId}, ${input.provider}, ${input.completedOn}::date,
      ${input.evidenceReference}, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findTraining(id: string, executor: Kysely<Database> = this.db): Promise<TrainingCompletion | undefined> {
    const row = await executor.selectFrom('aml_training_completions as t')
      .innerJoin('accounts as subject', 'subject.id', 't.account_id')
      .innerJoin('accounts as recorder', 'recorder.id', 't.recorded_by')
      .innerJoin('aml_control_versions as material', 'material.id', 't.training_material_id')
      .select(['t.id', 't.provider', 't.completed_on', 't.evidence_reference', 't.recorded_at',
        'subject.id as account_id', 'subject.display_name as account_name',
        'recorder.id as recorded_by_id', 'recorder.display_name as recorded_by_name',
        'material.id as material_id', 'material.version as material_version', 'material.title as material_title'])
      .where('t.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, account: { accountId: row.account_id, displayName: row.account_name },
      material: { id: row.material_id, version: row.material_version, title: row.material_title },
      provider: row.provider, completedOn: row.completed_on, evidenceReference: row.evidence_reference,
      recordedBy: { accountId: row.recorded_by_id, displayName: row.recorded_by_name }, recordedAt: row.recorded_at,
    };
  }

  async listTraining(accountId?: string, before?: string): Promise<TrainingCompletion[]> {
    let query = this.db.selectFrom('aml_training_completions').select('id');
    if (accountId) query = query.where('account_id', '=', accountId);
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findTraining(row.id))))
      .filter((row): row is TrainingCompletion => row !== undefined);
  }

  async recordReview(input: {
    periodStart: string; periodEnd: string; completedOn: string; reviewerName: string;
    reviewerOrganisation: string | null; independenceBasis: string; scope: string;
    findings: string; recommendations: string; managementResponse: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_aml_independent_review(
      ${input.periodStart}::date, ${input.periodEnd}::date, ${input.completedOn}::date,
      ${input.reviewerName}, ${input.reviewerOrganisation}, ${input.independenceBasis}, ${input.scope},
      ${input.findings}, ${input.recommendations}, ${input.managementResponse}, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findReview(id: string, executor: Kysely<Database> = this.db): Promise<IndependentReview | undefined> {
    const row = await executor.selectFrom('aml_independent_reviews as r')
      .innerJoin('accounts as recorder', 'recorder.id', 'r.recorded_by')
      .select(['r.id', 'r.period_start', 'r.period_end', 'r.completed_on', 'r.reviewer_name',
        'r.reviewer_organisation', 'r.independence_basis', 'r.scope', 'r.findings', 'r.recommendations',
        'r.management_response', 'r.recorded_at', 'recorder.id as recorded_by_id',
        'recorder.display_name as recorded_by_name']).where('r.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, periodStart: row.period_start, periodEnd: row.period_end, completedOn: row.completed_on,
      reviewerName: row.reviewer_name, reviewerOrganisation: row.reviewer_organisation,
      independenceBasis: row.independence_basis, scope: row.scope, findings: row.findings,
      recommendations: row.recommendations, managementResponse: row.management_response,
      recordedBy: { accountId: row.recorded_by_id, displayName: row.recorded_by_name }, recordedAt: row.recorded_at,
    };
  }

  async listReviews(before?: string): Promise<IndependentReview[]> {
    let query = this.db.selectFrom('aml_independent_reviews').select('id');
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findReview(row.id))))
      .filter((row): row is IndependentReview => row !== undefined);
  }

  async newId(executor: Kysely<Database> = this.db): Promise<string> {
    const result = await sql<{ id: string }>`select uuidv7() as id`.execute(executor);
    return result.rows[0]!.id;
  }

  /** Raises 42501 for a client the actor may not see and P0002 for an unknown client. */
  async assertClientAccess(clientId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<void> {
    await sql`select app.assert_aml_client_access(${actorId}::uuid, ${clientId}::uuid)`.execute(executor);
  }

  async createCdd(clientId: string, intendedRelationship: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_aml_cdd_case(
      ${clientId}::uuid, ${intendedRelationship}, ${reason}, ${actorId}::uuid
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async cddStatus(clientId: string, caseId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<AmlCddStatus | undefined> {
    await this.assertClientAccess(clientId, actorId, executor);
    const row = await executor.selectFrom('aml_cdd_cases').select('status')
      .where('id', '=', caseId).where('client_id', '=', clientId).executeTakeFirst();
    return row?.status;
  }

  async addSubject(input: {
    id: string; caseId: string; kind: AmlSubjectKind; relationship: AmlSubjectRelationship;
    sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.add_aml_cdd_subject(
      ${input.id}::uuid, ${input.caseId}::uuid, ${input.kind}, ${input.relationship},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async addEvidence(input: {
    id: string; caseId: string; evidenceType: string; country: string | null; issuedOn: string | null; expiresOn: string | null;
    metadata: SealedComplianceData; mediaType: DocumentMediaType; sizeBytes: number; sha256: Buffer; storageKey: string;
    fileKey: SealedSecret; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { metadata, fileKey } = input;
    await sql`select app.add_aml_cdd_evidence(
      ${input.id}::uuid, ${input.caseId}::uuid, ${input.evidenceType}, ${input.country}::char(2),
      ${input.issuedOn}::date, ${input.expiresOn}::date,
      ${metadata.context}, ${metadata.keyVersion}::smallint, ${metadata.nonce}, ${metadata.ciphertext}, ${metadata.authTag},
      ${input.mediaType}, ${input.sizeBytes}, ${input.sha256}, ${input.storageKey},
      ${fileKey.keyVersion}::smallint, ${fileKey.nonce}, ${fileKey.ciphertext}, ${fileKey.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async addOwnership(input: {
    id: string; caseId: string; ownedSubjectId: string; controllerSubjectId: string;
    ownershipPercent: string | null; controlKind: string; sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.add_aml_cdd_ownership(
      ${input.id}::uuid, ${input.caseId}::uuid, ${input.ownedSubjectId}::uuid, ${input.controllerSubjectId}::uuid,
      ${input.ownershipPercent}::numeric, ${input.controlKind},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async addAuthority(input: {
    id: string; caseId: string; representativeSubjectId: string; representedSubjectId: string; evidenceId: string;
    authorityType: string; verifiedOn: string; sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.add_aml_cdd_authority(
      ${input.id}::uuid, ${input.caseId}::uuid, ${input.representativeSubjectId}::uuid, ${input.representedSubjectId}::uuid,
      ${input.evidenceId}::uuid, ${input.authorityType}, ${input.verifiedOn}::date,
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async addVerification(input: {
    id: string; caseId: string; subjectId: string; evidenceId: string; sourceType: string; country: string | null;
    checkedOn: string; expiresOn: string | null; method: string; outcome: string; provider: string | null; service: string | null;
    sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.add_aml_cdd_verification(
      ${input.id}::uuid, ${input.caseId}::uuid, ${input.subjectId}::uuid, ${input.evidenceId}::uuid,
      ${input.sourceType}, ${input.country}::char(2), ${input.checkedOn}::date, ${input.expiresOn}::date,
      ${input.method}, ${input.outcome}, ${input.provider}, ${input.service},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async submitCdd(caseId: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.submit_aml_cdd_case(${caseId}::uuid, ${actorId}::uuid)`.execute(trx);
  }

  async abandonCdd(caseId: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.abandon_aml_cdd_case(${caseId}::uuid, ${reason}, ${actorId}::uuid)`.execute(trx);
  }

  async listCdd(clientId: string, actorId: string, before?: string): Promise<CddCase[]> {
    await this.assertClientAccess(clientId, actorId);
    let query = this.db.selectFrom('aml_cdd_cases').select('id').where('client_id', '=', clientId);
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findCdd(clientId, row.id, actorId, true))))
      .filter((item): item is CddCase => item !== undefined);
  }

  async findCdd(clientId: string, caseId: string, actorId: string, accessChecked = false,
    executor: Kysely<Database> = this.db): Promise<CddCase | undefined> {
    if (!accessChecked) await this.assertClientAccess(clientId, actorId, executor);
    const row = await executor.selectFrom('aml_cdd_cases as c')
      .innerJoin('accounts as p', 'p.id', 'c.prepared_by')
      .leftJoin('accounts as abandoner', 'abandoner.id', 'c.abandoned_by')
      .select(['c.id', 'c.client_id', 'c.version', 'c.status', 'c.intended_relationship', 'c.reason',
        'c.client_snapshot', 'c.created_at', 'c.submitted_at', 'c.abandonment_reason', 'c.abandoned_at',
        'c.abandoned_by', 'p.id as prepared_by_id', 'p.display_name as prepared_by_name',
        'abandoner.display_name as abandoned_by_name'])
      .where('c.id', '=', caseId).where('c.client_id', '=', clientId)
      .executeTakeFirst();
    if (!row) return undefined;

    const [controls, subjects, evidence, ownership, authorities, verifications] = await Promise.all([
      executor.selectFrom('aml_cdd_case_controls as x')
        .innerJoin('aml_control_versions as v', 'v.id', 'x.control_version_id')
        .select(['v.id', 'v.kind', 'v.version'])
        .where('x.cdd_case_id', '=', caseId).orderBy('v.kind').execute(),
      executor.selectFrom('aml_cdd_subjects').selectAll().where('cdd_case_id', '=', caseId).orderBy('id').execute(),
      executor.selectFrom('aml_cdd_evidence').selectAll().where('cdd_case_id', '=', caseId).orderBy('id').execute(),
      executor.selectFrom('aml_cdd_ownership_controls').selectAll().where('cdd_case_id', '=', caseId).orderBy('id').execute(),
      executor.selectFrom('aml_cdd_authorities').selectAll().where('cdd_case_id', '=', caseId).orderBy('id').execute(),
      executor.selectFrom('aml_cdd_verifications').selectAll().where('cdd_case_id', '=', caseId).orderBy('id').execute(),
    ]);

    const abandonment = row.abandoned_by && row.abandoned_by_name && row.abandoned_at && row.abandonment_reason
      ? { by: { accountId: row.abandoned_by, displayName: row.abandoned_by_name }, at: row.abandoned_at, reason: row.abandonment_reason }
      : null;

    return {
      id: row.id, clientId: row.client_id, version: row.version, status: row.status,
      intendedRelationship: row.intended_relationship, reason: row.reason, clientSnapshot: row.client_snapshot,
      preparedBy: { accountId: row.prepared_by_id, displayName: row.prepared_by_name },
      createdAt: row.created_at, submittedAt: row.submitted_at, abandonment, controls,
      subjects: subjects.map((s) => ({
        id: s.id, kind: s.kind, relationship: s.relationship,
        details: this.open<CddSubjectDetails>(s.encryption_context, s.key_version, s.nonce, s.ciphertext, s.auth_tag),
        recordedAt: s.recorded_at,
      })),
      evidence: evidence.map((e) => ({
        id: e.id, evidenceType: e.evidence_type, country: e.country, issuedOn: e.issued_on, expiresOn: e.expires_on,
        ...this.open<EvidenceMetadata>(e.metadata_context, e.metadata_key_version, e.metadata_nonce, e.metadata_ciphertext, e.metadata_auth_tag),
        mediaType: e.media_type, sizeBytes: e.size_bytes, uploadedAt: e.uploaded_at,
      })),
      ownership: ownership.map((o) => ({
        id: o.id, ownedSubjectId: o.owned_subject_id, controllerSubjectId: o.controller_subject_id,
        ownershipPercent: o.ownership_percent, controlKind: o.control_kind,
        details: this.open<{ details: string }>(o.details_context, o.details_key_version, o.details_nonce, o.details_ciphertext, o.details_auth_tag).details,
        recordedAt: o.recorded_at,
      })),
      authorities: authorities.map((a) => ({
        id: a.id, representativeSubjectId: a.representative_subject_id, representedSubjectId: a.represented_subject_id,
        evidenceId: a.evidence_id, authorityType: a.authority_type, verifiedOn: a.verified_on,
        details: this.open<{ details: string }>(a.details_context, a.details_key_version, a.details_nonce, a.details_ciphertext, a.details_auth_tag).details,
        recordedAt: a.recorded_at,
      })),
      verifications: verifications.map((v) => ({
        id: v.id, subjectId: v.subject_id, evidenceId: v.evidence_id, sourceType: v.source_type, country: v.country,
        checkedOn: v.checked_on, expiresOn: v.expires_on, method: v.method, outcome: v.outcome,
        provider: v.provider, service: v.service,
        ...this.open<VerificationDetails>(v.details_context, v.details_key_version, v.details_nonce, v.details_ciphertext, v.details_auth_tag),
        verifiedAt: v.verified_at,
      })),
    };
  }

  /** The case must belong to the client whose access was checked, or another client's evidence would be reachable. */
  async evidenceForDownload(clientId: string, caseId: string, evidenceId: string, actorId: string) {
    await this.assertClientAccess(clientId, actorId);
    const e = await this.db.selectFrom('aml_cdd_evidence as e')
      .innerJoin('aml_cdd_cases as c', 'c.id', 'e.cdd_case_id')
      .selectAll('e')
      .where('e.id', '=', evidenceId).where('e.cdd_case_id', '=', caseId).where('c.client_id', '=', clientId)
      .executeTakeFirst();
    if (!e) return undefined;
    const { fileName } = this.open<EvidenceMetadata>(e.metadata_context, e.metadata_key_version, e.metadata_nonce, e.metadata_ciphertext, e.metadata_auth_tag);
    return {
      fileName, mediaType: e.media_type, sizeBytes: e.size_bytes, storageKey: e.storage_key,
      sealedKey: { keyVersion: e.file_key_version, nonce: e.file_key_nonce, ciphertext: e.wrapped_file_key, authTag: e.file_key_tag },
    };
  }

  async createCountryList(input: { countries: string[]; source: string; effectiveFrom: string; actorId: string },
    trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_aml_country_list(
      ${input.countries}::text[], ${input.source}, ${input.effectiveFrom}::date, ${input.actorId}::uuid
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async approveCountryList(id: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.approve_aml_country_list(${id}::uuid, ${actorId}::uuid)`.execute(trx);
  }

  async listCountryLists(pendingOnly: boolean, before?: string): Promise<CountryListVersion[]> {
    let query = this.db.selectFrom('aml_country_list_versions as v')
      .leftJoin('aml_country_list_approvals as a', 'a.country_list_version_id', 'v.id')
      .select('v.id');
    if (pendingOnly) query = query.where('a.id', 'is', null);
    if (before) query = query.where('v.id', '<', before);
    const rows = await query.orderBy('v.id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findCountryList(row.id))))
      .filter((item): item is CountryListVersion => item !== undefined);
  }

  async findCountryList(id: string, executor: Kysely<Database> = this.db): Promise<CountryListVersion | undefined> {
    const row = await executor.selectFrom('aml_country_list_versions as v')
      .innerJoin('accounts as p', 'p.id', 'v.prepared_by')
      .leftJoin('aml_country_list_approvals as a', 'a.country_list_version_id', 'v.id')
      .leftJoin('accounts as approver', 'approver.id', 'a.approved_by')
      .select(['v.id', 'v.version', 'v.countries', 'v.source', 'v.effective_from', 'v.prepared_at',
        'p.id as prepared_by_id', 'p.display_name as prepared_by_name',
        'a.approved_at', 'approver.id as approved_by_id', 'approver.display_name as approved_by_name'])
      .where('v.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, version: row.version, countries: row.countries, source: row.source, effectiveFrom: row.effective_from,
      preparedBy: { accountId: row.prepared_by_id, displayName: row.prepared_by_name }, preparedAt: row.prepared_at,
      approval: row.approved_at && row.approved_by_id && row.approved_by_name
        ? { approvedBy: { accountId: row.approved_by_id, displayName: row.approved_by_name }, approvedAt: row.approved_at }
        : null,
    };
  }

  /** Raises 42501 for a matter the actor may not see and P0002 for an unknown matter. */
  async assertMatterAccess(matterId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<void> {
    await sql`select app.assert_aml_matter_access(${actorId}::uuid, ${matterId}::uuid)`.execute(executor);
  }

  async submitRiskAssessment(input: {
    id: string; matterId: string; inScope: boolean; rating: AmlRiskRating; factors: RiskFactors;
    jurisdictions: string[]; expectedValue: AmlExpectedValue; reviewDueOn: string; reviewGraceDays: number;
    loweringGroundsGiven: boolean; sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { factors, sealed } = input;
    await sql`select app.submit_aml_risk_assessment(
      ${input.id}::uuid, ${input.matterId}::uuid, ${input.inScope}, ${input.rating},
      ${factors.pep}, ${factors.unusualTransactions}, ${factors.complexStructure}, ${factors.cash},
      ${factors.remoteInstruction}, ${factors.adverseInformation}, ${factors.sanctionsExposure}, ${factors.thirdPartyFunding},
      ${input.jurisdictions}::text[], ${input.expectedValue}, ${input.reviewDueOn}::date, ${input.reviewGraceDays}::smallint,
      ${input.loweringGroundsGiven},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async listRiskAssessments(matterId: string, actorId: string, before?: string): Promise<RiskAssessment[]> {
    await this.assertMatterAccess(matterId, actorId);
    let query = this.db.selectFrom('aml_risk_assessments').select('id').where('matter_id', '=', matterId);
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findRiskAssessment(matterId, row.id, actorId, true))))
      .filter((item): item is RiskAssessment => item !== undefined);
  }

  async findRiskAssessment(matterId: string, assessmentId: string, actorId: string, accessChecked = false,
    executor: Kysely<Database> = this.db): Promise<RiskAssessment | undefined> {
    if (!accessChecked) await this.assertMatterAccess(matterId, actorId, executor);
    const row = await executor.selectFrom('aml_risk_assessments as r')
      .innerJoin('accounts as p', 'p.id', 'r.prepared_by')
      .selectAll('r').select(['p.display_name as prepared_by_name'])
      .where('r.id', '=', assessmentId).where('r.matter_id', '=', matterId)
      .executeTakeFirst();
    if (!row) return undefined;
    const controls = await executor.selectFrom('aml_risk_assessment_controls as x')
      .innerJoin('aml_control_versions as v', 'v.id', 'x.control_version_id')
      .select(['v.id', 'v.kind', 'v.version'])
      .where('x.assessment_id', '=', assessmentId).orderBy('v.kind').execute();
    return {
      id: row.id, matterId: row.matter_id, clientId: row.client_id, version: row.version, inScope: row.in_scope,
      cddCaseId: row.cdd_case_id, countryListVersionId: row.country_list_version_id, rating: row.rating,
      factors: {
        pep: row.pep, highRiskCountry: row.high_risk_country, unusualTransactions: row.unusual_transactions,
        complexStructure: row.complex_structure, cash: row.cash, remoteInstruction: row.remote_instruction,
        adverseInformation: row.adverse_information, sanctionsExposure: row.sanctions_exposure,
        thirdPartyFunding: row.third_party_funding,
      },
      jurisdictions: row.jurisdictions, expectedValue: row.expected_value, lowersPrevious: row.lowers_previous,
      reviewDueOn: row.review_due_on, reviewGraceDays: row.review_grace_days,
      narrative: this.open<RiskNarrative>(row.encryption_context, row.key_version, row.nonce, row.ciphertext, row.auth_tag),
      controls, preparedBy: { accountId: row.prepared_by, displayName: row.prepared_by_name }, submittedAt: row.submitted_at,
    };
  }

  /** Whether the assessment, and the measure when given, belong to the matter named in the URL. */
  async workBelongs(matterId: string, assessmentId: string, measureId: string | null, executor: Kysely<Database> = this.db) {
    let query = executor.selectFrom('aml_risk_assessments as r').select('r.id')
      .where('r.id', '=', assessmentId).where('r.matter_id', '=', matterId);
    if (measureId) {
      query = query.innerJoin('aml_measures as m', 'm.assessment_id', 'r.id').where('m.id', '=', measureId);
    }
    return (await query.executeTakeFirst()) !== undefined;
  }

  async addMeasure(input: { id: string; assessmentId: string; kind: AmlMeasureKind; sealed: SealedComplianceData; actorId: string },
    trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.add_aml_measure(
      ${input.id}::uuid, ${input.assessmentId}::uuid, ${input.kind},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async recordMeasureResult(input: {
    id: string; measureId: string; outcome: AmlOutcome; evidenceIds: string[]; sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.record_aml_measure_result(
      ${input.id}::uuid, ${input.measureId}::uuid, ${input.outcome}, ${input.evidenceIds}::uuid[],
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async recordSourceConclusion(input: {
    id: string; assessmentId: string; kind: 'funds' | 'wealth'; subjectId: string | null;
    amountMinPence: string; amountMaxPence: string; outcome: AmlOutcome; evidenceIds: string[];
    sealed: SealedComplianceData; actorId: string;
  }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.record_aml_source_conclusion(
      ${input.id}::uuid, ${input.assessmentId}::uuid, ${input.kind}, ${input.subjectId}::uuid,
      ${input.amountMinPence}::bigint, ${input.amountMaxPence}::bigint, ${input.outcome}, ${input.evidenceIds}::uuid[],
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async findAssessmentWork(matterId: string, assessmentId: string, actorId: string, accessChecked = false,
    executor: Kysely<Database> = this.db): Promise<AssessmentWork | undefined> {
    if (!accessChecked) await this.assertMatterAccess(matterId, actorId, executor);
    if (!await this.workBelongs(matterId, assessmentId, null, executor)) return undefined;
    const [measures, results, conclusions] = await Promise.all([
      executor.selectFrom('aml_measures as m').innerJoin('accounts as a', 'a.id', 'm.recorded_by')
        .selectAll('m').select('a.display_name').where('m.assessment_id', '=', assessmentId).orderBy('m.recorded_at').orderBy('m.id').execute(),
      executor.selectFrom('aml_measure_results as r').innerJoin('aml_measures as m', 'm.id', 'r.measure_id')
        .innerJoin('accounts as a', 'a.id', 'r.recorded_by')
        .selectAll('r').select('a.display_name').where('m.assessment_id', '=', assessmentId).orderBy('r.recorded_at').orderBy('r.id').execute(),
      executor.selectFrom('aml_source_conclusions as c').innerJoin('accounts as a', 'a.id', 'c.recorded_by')
        .selectAll('c').select('a.display_name').where('c.assessment_id', '=', assessmentId).orderBy('c.recorded_at').orderBy('c.id').execute(),
    ]);
    const reasoning = (row: { encryption_context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer }) =>
      this.open<{ text: string }>(row.encryption_context, row.key_version, row.nonce, row.ciphertext, row.auth_tag).text;
    return {
      assessmentId,
      measures: measures.map((m) => ({
        id: m.id, kind: m.kind, enhanced: ENHANCED_MEASURES.has(m.kind), description: reasoning(m),
        recordedBy: { accountId: m.recorded_by, displayName: m.display_name }, recordedAt: m.recorded_at,
        results: results.filter((r) => r.measure_id === m.id).map((r) => ({
          id: r.id, outcome: r.outcome, evidenceIds: r.evidence_ids, reasoning: reasoning(r),
          recordedBy: { accountId: r.recorded_by, displayName: r.display_name }, recordedAt: r.recorded_at,
        })),
      })),
      conclusions: conclusions.map((c) => ({
        id: c.id, kind: c.kind, subjectId: c.subject_id, amountMinPence: c.amount_min_pence, amountMaxPence: c.amount_max_pence,
        outcome: c.outcome, evidenceIds: c.evidence_ids, reasoning: reasoning(c),
        recordedBy: { accountId: c.recorded_by, displayName: c.display_name }, recordedAt: c.recorded_at,
      })),
    };
  }

  private open<T>(context: string, keyVersion: number, nonce: Buffer, ciphertext: Buffer, authTag: Buffer): T {
    return this.cipher.open<T>({ context, keyVersion, nonce, ciphertext, authTag });
  }
}
