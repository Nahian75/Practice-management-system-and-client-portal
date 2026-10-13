import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import type { SealedComplianceData } from '../compliance/compliance-data-cipher.js';
import type {
  CompanySnapshot,
  ContactVerification,
  ContactVerificationState,
  ElectronicCheck,
  EvidenceRequest,
  PortalEvidenceRequest,
} from './onboarding.js';

interface VerificationRow {
  id: string; client_id: string; contact_id: string | null; channel: 'email'; address: string;
  requested_by: string; requested_by_name: string; requested_at: Date; expires_at: Date;
  verified_at: Date | null; attempt_count: string; current_address: string | null; newer_exists: boolean;
  database_now: Date;
}

@Injectable()
export class OnboardingRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async requestEmail(clientId: string, contactId: string | null, tokenHash: Buffer,
    actorId: string, trx: Kysely<Database>) {
    const result = await sql<{ id: string; address: string; expires_at: Date }>`
      select * from app.request_contact_email_verification(
        ${clientId}, ${contactId}, ${tokenHash}, ${actorId})`.execute(trx);
    return result.rows[0]!;
  }

  async completeEmail(tokenHash: Buffer): Promise<{ outcome: string; requestId: string | null }> {
    const result = await sql<{ outcome: string; request_id: string | null }>`
      select * from app.complete_contact_email_verification(${tokenHash})`.execute(this.db);
    return { outcome: result.rows[0]!.outcome, requestId: result.rows[0]!.request_id };
  }

  async listContactVerifications(clientId: string, actorId: string): Promise<ContactVerification[]> {
    return this.transaction(async (trx) => {
      await sql`select app.assert_aml_client_access(${actorId}, ${clientId})`.execute(trx);
      const result = await sql<VerificationRow>`
        select request.id, request.client_id, request.contact_id, request.channel, request.address,
          request.requested_by, account.display_name as requested_by_name,
          request.requested_at, request.expires_at, request.verified_at,
          (select count(*) from app.contact_verification_attempts attempt
            where attempt.request_id = request.id)::text as attempt_count,
          case when request.contact_id is null then lower(btrim(individual.email))
            else lower(btrim(contact.email)) end as current_address,
          exists(select 1 from app.contact_verification_requests newer
            where newer.client_id = request.client_id
              and newer.contact_id is not distinct from request.contact_id
              and (newer.requested_at, newer.id) > (request.requested_at, request.id)) as newer_exists,
          clock_timestamp() as database_now
        from app.contact_verification_requests request
        join app.accounts account on account.id = request.requested_by
        left join app.client_individuals individual on individual.client_id = request.client_id
          and request.contact_id is null
        left join app.client_contacts contact on contact.id = request.contact_id and contact.active
        where request.client_id = ${clientId}
        order by request.requested_at desc, request.id desc
        limit 100`.execute(trx);
      return result.rows.map(fromRow);
    });
  }

  async newId(executor: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  async createEvidenceRequest(input: { clientId: string; caseId: string; contactId: string | null;
    evidenceType: string; instructions: string; country: string | null; dueOn: string; actorId: string },
    trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_onboarding_evidence_request(
      ${input.clientId},${input.caseId},${input.contactId},${input.evidenceType},${input.instructions},
      ${input.country}::char(2),${input.dueOn}::date,${input.actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findEvidenceRequest(id: string, executor: Kysely<Database> = this.db): Promise<EvidenceRequest | undefined> {
    const row = await executor.selectFrom('onboarding_evidence_requests as request')
      .innerJoin('accounts as requester', 'requester.id', 'request.requested_by')
      .leftJoin('onboarding_evidence_submissions as submission', 'submission.request_id', 'request.id')
      .leftJoin('accounts as uploader', 'uploader.id', 'submission.uploaded_by')
      .leftJoin('onboarding_evidence_reviews as review', 'review.request_id', 'request.id')
      .leftJoin('accounts as reviewer', 'reviewer.id', 'review.reviewed_by')
      .select([
        'request.id','request.client_id','request.cdd_case_id','request.contact_id','request.evidence_type',
        'request.instructions','request.country','request.due_on','request.requested_at',
        'requester.id as requester_id','requester.display_name as requester_name',
        'submission.id as submission_id','submission.evidence_id','submission.uploaded_at',
        'uploader.id as uploader_id','uploader.display_name as uploader_name',
        'review.id as review_id','review.outcome as review_outcome','review.reason as review_reason',
        'review.exception_note as review_exception_note','review.reviewed_at as review_reviewed_at',
        'reviewer.id as reviewer_id','reviewer.display_name as reviewer_name',
      ])
      .where('request.id','=',id).executeTakeFirst();
    if (!row) return undefined;
    const submission = row.submission_id && row.evidence_id && row.uploaded_at && row.uploader_id && row.uploader_name
      ? { id: row.submission_id, evidenceId: row.evidence_id, uploadedAt: row.uploaded_at,
        uploadedBy: { accountId: row.uploader_id, displayName: row.uploader_name } } : null;
    const review = row.review_id && row.review_outcome && row.review_reason && row.review_reviewed_at && row.reviewer_id && row.reviewer_name && row.evidence_id
      ? { id: row.review_id, requestId: row.id, evidenceId: row.evidence_id, outcome: row.review_outcome,
        reason: row.review_reason, exceptionNote: row.review_exception_note, reviewedAt: row.review_reviewed_at,
        reviewedBy: { accountId: row.reviewer_id, displayName: row.reviewer_name } } : null;
    return {
      id: row.id, clientId: row.client_id, cddCaseId: row.cdd_case_id, contactId: row.contact_id,
      evidenceType: row.evidence_type, instructions: row.instructions, country: row.country, dueOn: row.due_on,
      requestedBy: { accountId: row.requester_id, displayName: row.requester_name }, requestedAt: row.requested_at,
      submission, review,
    };
  }

  async listEvidenceRequests(clientId: string, caseId: string, actorId: string): Promise<EvidenceRequest[]> {
    await sql`select app.assert_aml_client_access(${actorId},${clientId})`.execute(this.db);
    const rows = await this.db.selectFrom('onboarding_evidence_requests').select('id')
      .where('client_id','=',clientId).where('cdd_case_id','=',caseId).orderBy('id','desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findEvidenceRequest(row.id))))
      .filter((row): row is EvidenceRequest => row !== undefined);
  }

  async listPortalEvidenceRequests(accountId: string,
    executor: Kysely<Database> = this.db): Promise<PortalEvidenceRequest[]> {
    const rows = await sql<{ id: string; evidence_type: string; instructions: string; due_on: string;
      uploaded_at: Date | null }>`
      select request.id,request.evidence_type,request.instructions,request.due_on,submission.uploaded_at
      from app.onboarding_evidence_requests request
      join app.portal_links link on link.client_id=request.client_id and link.account_id=${accountId}
        and link.ended_at is null and link.contact_id is not distinct from request.contact_id
      join app.aml_cdd_cases cdd on cdd.id=request.cdd_case_id and cdd.status='draft'
      left join app.onboarding_evidence_submissions submission on submission.request_id=request.id
      order by request.due_on,request.id limit 100`.execute(executor);
    return rows.rows.map((row) => ({ id: row.id, evidenceType: row.evidence_type,
      instructions: row.instructions, dueOn: row.due_on, state: row.uploaded_at ? 'submitted' : 'open',
      submittedAt: row.uploaded_at }));
  }

  async portalEvidenceRequest(id: string, accountId: string,
    executor: Kysely<Database> = this.db): Promise<PortalEvidenceRequest | undefined> {
    return (await this.listPortalEvidenceRequests(accountId, executor)).find((item) => item.id === id);
  }

  async addPortalEvidence(input: { requestId: string; evidenceId: string; metadata: SealedComplianceData;
    mediaType: string; sizeBytes: number; sha256: Buffer; storageKey: string; fileKey: SealedSecret; actorId: string },
    trx: Kysely<Database>): Promise<void> {
    const { metadata, fileKey } = input;
    await sql`select app.add_portal_aml_evidence(${input.requestId},${input.evidenceId},${metadata.context},
      ${metadata.keyVersion}::smallint,${metadata.nonce},${metadata.ciphertext},${metadata.authTag},
      ${input.mediaType},${input.sizeBytes},${input.sha256},${input.storageKey},${fileKey.keyVersion}::smallint,
      ${fileKey.nonce},${fileKey.ciphertext},${fileKey.authTag},${input.actorId})`.execute(trx);
  }

  async reviewEvidence(input: {
    requestId: string; evidenceId: string; outcome: 'accepted' | 'rejected';
    reason: string; exceptionNote: string | null; actorId: string;
  }, trx: Kysely<Database> = this.db): Promise<string> {
    const result = await sql<{ id: string }>`select app.review_onboarding_evidence(
      ${input.requestId}, ${input.evidenceId}, ${input.outcome}, ${input.reason},
      ${input.exceptionNote}, ${input.actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async recordElectronicCheck(input: {
    clientId: string; cddCaseId: string | null; provider: string; service: string;
    providerReference: string; documentType: string; checkDate: string;
    result: 'pass' | 'refer' | 'fail'; livenessResult: 'pass' | 'refer' | 'fail' | 'not_checked' | null;
    evidenceMatch: string | null; exceptionNote: string | null; rawResponseHash: Buffer;
    actorId: string;
  }, trx: Kysely<Database> = this.db): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_onboarding_electronic_check(
      ${input.clientId}, ${input.cddCaseId}, ${input.provider}, ${input.service},
      ${input.providerReference}, ${input.documentType}, ${input.checkDate}::date,
      ${input.result}, ${input.livenessResult}, ${input.evidenceMatch}, ${input.exceptionNote},
      ${input.rawResponseHash}, ${input.actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async listElectronicChecks(clientId: string, actorId: string): Promise<ElectronicCheck[]> {
    await sql`select app.assert_aml_client_access(${actorId}, ${clientId})`.execute(this.db);
    const rows = await this.db.selectFrom('onboarding_electronic_checks as check')
      .innerJoin('accounts as recorder', 'recorder.id', 'check.recorded_by')
      .select([
        'check.id', 'check.client_id', 'check.cdd_case_id', 'check.provider', 'check.service',
        'check.provider_reference', 'check.document_type', 'check.check_date', 'check.result',
        'check.liveness_result', 'check.evidence_match', 'check.exception_note', 'check.raw_response_hash',
        'check.recorded_at', 'recorder.id as recorder_id', 'recorder.display_name as recorder_name',
      ])
      .where('check.client_id', '=', clientId)
      .orderBy('check.recorded_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      cddCaseId: row.cdd_case_id,
      provider: row.provider,
      service: row.service,
      providerReference: row.provider_reference,
      documentType: row.document_type,
      checkDate: row.check_date,
      result: row.result,
      livenessResult: row.liveness_result,
      evidenceMatch: row.evidence_match,
      exceptionNote: row.exception_note,
      rawResponseHash: row.raw_response_hash.toString('hex'),
      recordedBy: { accountId: row.recorder_id, displayName: row.recorder_name },
      recordedAt: row.recorded_at,
    }));
  }

  async recordCompanySnapshot(input: {
    clientId: string; cddCaseId: string | null; source: 'companies_house' | 'overseas_registry' | 'manual_evidence';
    companyNumber: string; companyName: string; companyStatus: string; companyType: string | null;
    jurisdiction: string | null; incorporationDate: string | null; registeredOffice: Record<string, unknown>;
    officers: unknown[]; discrepancies: unknown[]; rawPayloadHash: Buffer; actorId: string;
  }, trx: Kysely<Database> = this.db): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_onboarding_company_snapshot(
      ${input.clientId}, ${input.cddCaseId}, ${input.source}, ${input.companyNumber},
      ${input.companyName}, ${input.companyStatus}, ${input.companyType}, ${input.jurisdiction},
      ${input.incorporationDate ? sql`${input.incorporationDate}::date` : null},
      ${JSON.stringify(input.registeredOffice)}::jsonb,
      ${JSON.stringify(input.officers)}::jsonb,
      ${JSON.stringify(input.discrepancies)}::jsonb,
      ${input.rawPayloadHash}, ${input.actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async listCompanySnapshots(clientId: string, actorId: string): Promise<CompanySnapshot[]> {
    await sql`select app.assert_aml_client_access(${actorId}, ${clientId})`.execute(this.db);
    const rows = await this.db.selectFrom('onboarding_company_snapshots as snapshot')
      .innerJoin('accounts as recorder', 'recorder.id', 'snapshot.recorded_by')
      .select([
        'snapshot.id', 'snapshot.client_id', 'snapshot.cdd_case_id', 'snapshot.source',
        'snapshot.company_number', 'snapshot.company_name', 'snapshot.company_status',
        'snapshot.company_type', 'snapshot.jurisdiction', 'snapshot.incorporation_date',
        'snapshot.registered_office', 'snapshot.officers', 'snapshot.discrepancies',
        'snapshot.raw_payload_hash', 'snapshot.retrieved_at',
        'recorder.id as recorder_id', 'recorder.display_name as recorder_name',
      ])
      .where('snapshot.client_id', '=', clientId)
      .orderBy('snapshot.retrieved_at', 'desc')
      .limit(100)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      cddCaseId: row.cdd_case_id,
      source: row.source,
      companyNumber: row.company_number,
      companyName: row.company_name,
      companyStatus: row.company_status,
      companyType: row.company_type,
      jurisdiction: row.jurisdiction,
      incorporationDate: row.incorporation_date,
      registeredOffice: row.registered_office,
      officers: row.officers,
      discrepancies: (row.discrepancies ?? []) as any[],
      rawPayloadHash: row.raw_payload_hash.toString('hex'),
      retrievedAt: row.retrieved_at,
      recordedBy: { accountId: row.recorder_id, displayName: row.recorder_name },
    }));
  }

  async findClientOrganisation(clientId: string) {
    return this.db.selectFrom('client_organisations')
      .selectAll()
      .where('client_id', '=', clientId)
      .executeTakeFirst();
  }
}

function fromRow(row: VerificationRow): ContactVerification {
  let state: ContactVerificationState;
  if (row.current_address !== row.address) state = 'address_changed';
  else if (row.verified_at) state = 'verified';
  else if (row.newer_exists) state = 'superseded';
  else if (row.database_now >= row.expires_at) state = 'expired';
  else state = 'pending';
  return {
    id: row.id, clientId: row.client_id, contactId: row.contact_id, channel: row.channel,
    address: row.address, state, attemptCount: Number(row.attempt_count),
    requestedBy: { accountId: row.requested_by, displayName: row.requested_by_name },
    requestedAt: row.requested_at, expiresAt: row.expires_at, verifiedAt: row.verified_at,
  };
}
