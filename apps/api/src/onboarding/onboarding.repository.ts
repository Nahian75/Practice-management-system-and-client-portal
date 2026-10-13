import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import type { SealedComplianceData } from '../compliance/compliance-data-cipher.js';
import type { ContactVerification, ContactVerificationState, EvidenceRequest, PortalEvidenceRequest } from './onboarding.js';

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
      .select(['request.id','request.client_id','request.cdd_case_id','request.contact_id','request.evidence_type',
        'request.instructions','request.country','request.due_on','request.requested_at',
        'requester.id as requester_id','requester.display_name as requester_name','submission.id as submission_id',
        'submission.evidence_id','submission.uploaded_at','uploader.id as uploader_id','uploader.display_name as uploader_name'])
      .where('request.id','=',id).executeTakeFirst();
    if (!row) return undefined;
    return { id: row.id, clientId: row.client_id, cddCaseId: row.cdd_case_id, contactId: row.contact_id,
      evidenceType: row.evidence_type, instructions: row.instructions, country: row.country, dueOn: row.due_on,
      requestedBy: { accountId: row.requester_id, displayName: row.requester_name }, requestedAt: row.requested_at,
      submission: row.submission_id && row.evidence_id && row.uploaded_at && row.uploader_id && row.uploader_name
        ? { id: row.submission_id, evidenceId: row.evidence_id, uploadedAt: row.uploaded_at,
          uploadedBy: { accountId: row.uploader_id, displayName: row.uploader_name } } : null };
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
