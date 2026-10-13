import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActor } from '../audit/audit-event.js';
import { generateOpaqueToken, hashOpaqueToken } from '../common/crypto/opaque-token.js';
import type { RequestContext } from '../common/http/request-context.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MailOutbox } from '../mail/mail-outbox.js';
import { AmlEvidenceIntake, type AmlEvidenceRefusal } from '../compliance/aml-evidence-intake.js';
import { AmlEvidenceVault } from '../compliance/aml-evidence-vault.js';
import { ComplianceDataCipher } from '../compliance/compliance-data-cipher.js';
import { text } from '../common/validation/safe-text.js';
import { sql } from 'kysely';
import type {
  ActivationException,
  ActivationGate,
  CompanyDiscrepancy,
  CompanySnapshot,
  ConflictAlias,
  ConflictConnectedPerson,
  ConflictDecision,
  ContactVerification,
  ElectronicCheck,
  EvidenceRequest,
  PortalEvidenceRequest,
  EngagementDocument,
  EngagementTemplate,
  SignerRole,
  SignatureMethod,
  MatterFeeEstimate,
  MatterChargingBasis,
  OnboardingPaymentRequest,
  OnboardingPaymentRequestKind,
  OnboardingPaymentMethod,
  PortalPaymentRequest,
} from './onboarding.js';
import { OnboardingRepository } from './onboarding.repository.js';

export interface OnboardingActor { actor: AuditActor; accountId: string; context?: RequestContext }
export type VerificationRequestResult =
  | { outcome: 'sent'; verification: ContactVerification }
  | { outcome: 'not_found' | 'conflict' | 'limited' };
export type EvidenceUploadResult = { outcome: 'uploaded'; request: PortalEvidenceRequest }
  | { outcome: 'not_found' | 'conflict' }
  | { outcome: 'refused'; reason: AmlEvidenceRefusal | 'file_name' | 'over_allowance' };
const fileName = text(255);

@Injectable()
export class OnboardingService {
  constructor(private readonly records: OnboardingRepository, private readonly audit: AuditService,
    private readonly outbox: MailOutbox, private readonly intake: AmlEvidenceIntake,
    private readonly vault: AmlEvidenceVault, private readonly cipher: ComplianceDataCipher,
    @Inject(ENV) private readonly env: Env) {}

  async requestEmail(clientId: string, contactId: string | null,
    by: OnboardingActor): Promise<VerificationRequestResult> {
    const token = generateOpaqueToken();
    try {
      const id = await this.records.transaction(async (trx) => {
        const created = await this.records.requestEmail(clientId, contactId, hashOpaqueToken(token), by.accountId, trx);
        await this.outbox.enqueueInTransaction({
          to: created.address, subject: 'Verify your email address',
          text: verificationEmail(this.verificationLink(token)),
        }, {
          kind: 'contact_verification', resource: { type: 'contact_verification_request', id: created.id },
          deduplicationKey: `contact-verification:${created.id}`, discardAfter: created.expires_at,
          actor: by.actor, context: by.context,
        }, trx);
        await this.audit.record({ actor: by.actor, action: 'onboarding.contact_verification_requested', outcome: 'success',
          resource: { type: 'contact_verification_request', id: created.id },
          metadata: { clientId, channel: 'email', ...(contactId ? { contactId } : {}) }, ...by.context }, trx);
        return created.id;
      });
      const verification = (await this.records.listContactVerifications(clientId, by.accountId))
        .find((item) => item.id === id);
      return verification ? { outcome: 'sent', verification } : { outcome: 'not_found' };
    } catch (error) {
      if (hasCode(error, '54000')) return { outcome: 'limited' };
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (['23503', '23505', '23514'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listContactVerifications(clientId: string, actorId: string): Promise<ContactVerification[] | undefined> {
    try { return await this.records.listContactVerifications(clientId, actorId); }
    catch (error) { if (hasCode(error, '42501') || hasCode(error, 'P0002')) return undefined; throw error; }
  }

  async completeEmail(token: string, context?: RequestContext): Promise<'verified' | 'invalid'> {
    const result = await this.records.completeEmail(hashOpaqueToken(token));
    if (result.outcome !== 'verified' || !result.requestId) return 'invalid';
    await this.audit.record({ actor: { type: 'anonymous' }, action: 'onboarding.contact_verified', outcome: 'success',
      resource: { type: 'contact_verification_request', id: result.requestId }, metadata: { channel: 'email' }, ...context });
    return 'verified';
  }

  async createEvidenceRequest(input: { clientId: string; caseId: string; contactId: string | null;
    evidenceType: string; instructions: string; country: string | null; dueOn: string },
    by: OnboardingActor): Promise<EvidenceRequest | undefined> {
    try {
      return await this.records.transaction(async (trx) => {
        const id = await this.records.createEvidenceRequest({ ...input, actorId: by.accountId }, trx);
        const created = await this.records.findEvidenceRequest(id, trx);
        if (!created) return undefined;
        await this.audit.record({ actor: by.actor, action: 'onboarding.evidence_requested', outcome: 'success',
          resource: { type: 'onboarding_evidence_request', id },
          metadata: { clientId: input.clientId, caseId: input.caseId, ...(input.contactId ? { contactId: input.contactId } : {}) },
          ...by.context }, trx);
        return created;
      });
    } catch (error) {
      if (hasCode(error,'42501') || hasCode(error,'P0002') || hasCode(error,'23503')) return undefined;
      if (hasCode(error,'23514')) return undefined;
      throw error;
    }
  }

  async listEvidenceRequests(clientId: string, caseId: string, actorId: string): Promise<EvidenceRequest[] | undefined> {
    try { return await this.records.listEvidenceRequests(clientId, caseId, actorId); }
    catch (error) { if (hasCode(error,'42501') || hasCode(error,'P0002')) return undefined; throw error; }
  }

  listPortalEvidenceRequests(accountId: string) { return this.records.listPortalEvidenceRequests(accountId); }

  async uploadPortalEvidence(requestId: string, input: { fileName: string; file: Readable },
    by: OnboardingActor): Promise<EvidenceUploadResult> {
    const open = await this.records.portalEvidenceRequest(requestId, by.accountId);
    if (!open || open.state !== 'open') { input.file.resume(); return { outcome: open ? 'conflict' : 'not_found' }; }
    const checkedName = fileName.safeParse(input.fileName);
    if (!checkedName.success) { input.file.resume(); return { outcome: 'refused', reason: 'file_name' }; }
    const recent = await this.audit.recentTotals({ actorId: by.accountId, actions: ['onboarding.evidence_uploaded'],
      seconds: 3600, field: 'sizeBytes' });
    if (recent.count >= 20 || recent.total >= 500 * 1024 ** 2) { input.file.resume(); return { outcome: 'refused', reason: 'over_allowance' }; }
    const received = await this.intake.receive(checkedName.data, input.file);
    if ('reason' in received) return { outcome: 'refused', reason: received.reason };
    try {
      const value = await this.records.transaction(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`app.portal_evidence:${by.accountId}`},0))`.execute(trx);
        const totals = await this.audit.recentTotals({ actorId: by.accountId, actions: ['onboarding.evidence_uploaded'],
          seconds: 3600, field: 'sizeBytes' }, trx);
        if (totals.count >= 20 || totals.total + received.inspected.sizeBytes > 500 * 1024 ** 2) return undefined;
        const evidenceId = await this.records.newId(trx);
        await this.records.addPortalEvidence({ requestId, evidenceId,
          metadata: this.cipher.seal({ fileName: checkedName.data, documentIdentifier: null,
            providerPayloadHash: null }, `aml-evidence-metadata:${evidenceId}`),
          mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes,
          sha256: received.inspected.sha256, storageKey: received.stored.storageKey,
          fileKey: received.stored.sealedKey, actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'onboarding.evidence_uploaded', outcome: 'success',
          resource: { type: 'onboarding_evidence_request', id: requestId },
          metadata: { sizeBytes: received.inspected.sizeBytes, mediaType: received.inspected.mediaType }, ...by.context }, trx);
        return this.records.portalEvidenceRequest(requestId, by.accountId, trx);
      });
      if (!value) { await this.vault.discard(received.stored.storageKey); return { outcome: 'refused', reason: 'over_allowance' }; }
      return { outcome: 'uploaded', request: value };
    } catch (error) {
      await this.vault.discard(received.stored.storageKey);
      if (hasCode(error,'42501') || hasCode(error,'P0002')) return { outcome: 'not_found' };
      if (hasCode(error,'23505') || hasCode(error,'23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async reviewEvidence(input: {
    clientId: string; caseId: string; requestId: string; evidenceId: string;
    outcome: 'accepted' | 'rejected'; reason: string; exceptionNote?: string;
  }, by: OnboardingActor): Promise<{ outcome: 'recorded'; reviewId: string } | { outcome: 'not_found' | 'conflict' }> {
    try {
      const reviewId = await this.records.transaction(async (trx) => {
        const id = await this.records.reviewEvidence({
          requestId: input.requestId,
          evidenceId: input.evidenceId,
          outcome: input.outcome,
          reason: input.reason,
          exceptionNote: input.exceptionNote ?? null,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.evidence_reviewed',
          outcome: 'success',
          resource: { type: 'onboarding_evidence_review', id },
          metadata: {
            clientId: input.clientId,
            caseId: input.caseId,
            requestId: input.requestId,
            evidenceId: input.evidenceId,
            reviewOutcome: input.outcome,
          },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'recorded', reviewId };
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async recordElectronicCheck(input: {
    clientId: string; cddCaseId?: string; provider: string; service: string;
    providerReference: string; documentType: string; checkDate: string;
    result: 'pass' | 'refer' | 'fail'; livenessResult?: 'pass' | 'refer' | 'fail' | 'not_checked';
    evidenceMatch?: string; exceptionNote?: string; rawResponseJson: string;
  }, by: OnboardingActor): Promise<{ outcome: 'recorded'; checkId: string } | { outcome: 'not_found' | 'conflict' }> {
    const rawHash = createHash('sha256').update(input.rawResponseJson).digest();
    try {
      const checkId = await this.records.transaction(async (trx) => {
        const id = await this.records.recordElectronicCheck({
          clientId: input.clientId,
          cddCaseId: input.cddCaseId ?? null,
          provider: input.provider,
          service: input.service,
          providerReference: input.providerReference,
          documentType: input.documentType,
          checkDate: input.checkDate,
          result: input.result,
          livenessResult: input.livenessResult ?? null,
          evidenceMatch: input.evidenceMatch ?? null,
          exceptionNote: input.exceptionNote ?? null,
          rawResponseHash: rawHash,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.electronic_check_recorded',
          outcome: 'success',
          resource: { type: 'onboarding_electronic_check', id },
          metadata: {
            clientId: input.clientId,
            provider: input.provider,
            service: input.service,
            result: input.result,
          },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'recorded', checkId };
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listElectronicChecks(clientId: string, actorId: string): Promise<ElectronicCheck[] | undefined> {
    try {
      return await this.records.listElectronicChecks(clientId, actorId);
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return undefined;
      throw error;
    }
  }

  isCompaniesHouseConfigured(): boolean {
    return Boolean(this.env.COMPANIES_HOUSE_API_KEY);
  }

  async lookupCompaniesHouse(clientId: string, companyNumber: string): Promise<{
    available: boolean;
    snapshot?: {
      companyNumber: string;
      companyName: string;
      companyStatus: string;
      companyType: string | null;
      jurisdiction: string | null;
      incorporationDate: string | null;
      registeredOffice: Record<string, unknown>;
      officers: unknown[];
      rawPayloadJson: string;
    };
    discrepancies?: CompanyDiscrepancy[];
    error?: string;
  }> {
    if (!this.env.COMPANIES_HOUSE_API_KEY) {
      return { available: false, error: 'Companies House integration is not configured' };
    }
    const org = await this.records.findClientOrganisation(clientId);
    const baseUrl = this.env.COMPANIES_HOUSE_API_URL ?? 'https://api.company-information.service.gov.uk';
    const authHeader = `Basic ${Buffer.from(`${this.env.COMPANIES_HOUSE_API_KEY}:`).toString('base64')}`;

    const profileRes = await fetch(`${baseUrl}/company/${encodeURIComponent(companyNumber)}`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (profileRes.status === 404) {
      return { available: true, error: 'Company not found on Companies House register' };
    }
    if (!profileRes.ok) {
      return { available: true, error: `Companies House API returned status ${profileRes.status}` };
    }
    const profile = await profileRes.json() as any;

    let officers: any[] = [];
    try {
      const officersRes = await fetch(`${baseUrl}/company/${encodeURIComponent(companyNumber)}/officers`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (officersRes.ok) {
        const officersData = await officersRes.json() as any;
        officers = officersData.items ?? [];
      }
    } catch {
      // Officer fetch non-fatal
    }

    const rawPayload = JSON.stringify({ profile, officers });
    const discrepancies: CompanyDiscrepancy[] = [];

    if (org) {
      if (org.legal_name && profile.company_name &&
          org.legal_name.trim().toLowerCase() !== profile.company_name.trim().toLowerCase()) {
        discrepancies.push({
          field: 'legal_name',
          clientValue: org.legal_name,
          companiesHouseValue: profile.company_name,
          description: `Client registered name ("${org.legal_name}") differs from Companies House ("${profile.company_name}")`,
        });
      }
      if (org.registration_number && profile.company_number &&
          org.registration_number.trim().toUpperCase() !== profile.company_number.trim().toUpperCase()) {
        discrepancies.push({
          field: 'registration_number',
          clientValue: org.registration_number,
          companiesHouseValue: profile.company_number,
          description: `Client registration number ("${org.registration_number}") differs from Companies House ("${profile.company_number}")`,
        });
      }
      if (profile.company_status && profile.company_status !== 'active') {
        discrepancies.push({
          field: 'company_status',
          companiesHouseValue: profile.company_status,
          description: `Company status on register is "${profile.company_status}" (not active)`,
        });
      }
      const profilePostcode = profile.registered_office_address?.postal_code;
      if (org.postcode && profilePostcode &&
          org.postcode.replace(/\s+/g, '').toUpperCase() !== profilePostcode.replace(/\s+/g, '').toUpperCase()) {
        discrepancies.push({
          field: 'registered_office_postcode',
          clientValue: org.postcode,
          companiesHouseValue: profilePostcode,
          description: `Client postal code ("${org.postcode}") differs from Companies House registered office ("${profilePostcode}")`,
        });
      }
    }

    return {
      available: true,
      snapshot: {
        companyNumber: profile.company_number ?? companyNumber,
        companyName: profile.company_name ?? '',
        companyStatus: profile.company_status ?? 'unknown',
        companyType: profile.type ?? null,
        jurisdiction: profile.jurisdiction ?? null,
        incorporationDate: profile.date_of_creation ?? null,
        registeredOffice: profile.registered_office_address ?? {},
        officers,
        rawPayloadJson: rawPayload,
      },
      discrepancies,
    };
  }

  async recordCompanySnapshot(input: {
    clientId: string; cddCaseId?: string; source: 'companies_house' | 'overseas_registry' | 'manual_evidence';
    companyNumber: string; companyName: string; companyStatus: string; companyType?: string;
    jurisdiction?: string; incorporationDate?: string; registeredOffice: Record<string, unknown>;
    officers: unknown[]; discrepancies: CompanyDiscrepancy[]; rawPayloadJson: string;
  }, by: OnboardingActor): Promise<{ outcome: 'recorded'; snapshotId: string } | { outcome: 'not_found' | 'conflict' }> {
    const rawHash = createHash('sha256').update(input.rawPayloadJson).digest();
    try {
      const snapshotId = await this.records.transaction(async (trx) => {
        const id = await this.records.recordCompanySnapshot({
          clientId: input.clientId,
          cddCaseId: input.cddCaseId ?? null,
          source: input.source,
          companyNumber: input.companyNumber,
          companyName: input.companyName,
          companyStatus: input.companyStatus,
          companyType: input.companyType ?? null,
          jurisdiction: input.jurisdiction ?? null,
          incorporationDate: input.incorporationDate ?? null,
          registeredOffice: input.registeredOffice,
          officers: input.officers,
          discrepancies: input.discrepancies,
          rawPayloadHash: rawHash,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.company_snapshot_recorded',
          outcome: 'success',
          resource: { type: 'onboarding_company_snapshot', id },
          metadata: {
            clientId: input.clientId,
            source: input.source,
            companyNumber: input.companyNumber,
            companyStatus: input.companyStatus,
            discrepancyCount: input.discrepancies.length,
          },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'recorded', snapshotId };
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listCompanySnapshots(clientId: string, actorId: string): Promise<CompanySnapshot[] | undefined> {
    try {
      return await this.records.listCompanySnapshots(clientId, actorId);
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return undefined;
      throw error;
    }
  }

  async addConflictAlias(
    clientId: string,
    input: { name: string; kind: 'alias' | 'former_name' | 'trading_name'; notes: string | null },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded'; alias: ConflictAlias } | { outcome: 'conflict' | 'not_found' }> {
    try {
      const alias = await this.records.transaction(async (trx) => {
        const created = await this.records.recordConflictAlias({ clientId, ...input, actorId: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.conflict_alias_added',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { aliasId: created.id, name: input.name, kind: input.kind },
          ...by.context,
        }, trx);
        return created;
      });
      return { outcome: 'recorded', alias };
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listConflictAliases(clientId: string): Promise<ConflictAlias[]> {
    return this.records.listConflictAliases(clientId);
  }

  async addConflictConnectedPerson(
    clientId: string,
    input: {
      name: string;
      relationship: 'director' | 'shareholder' | 'beneficial_owner' | 'connected_person' | 'counterparty' | 'officer' | 'guarantor';
      companyName: string | null;
      notes: string | null;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded'; person: ConflictConnectedPerson } | { outcome: 'conflict' | 'not_found' }> {
    try {
      const person = await this.records.transaction(async (trx) => {
        const created = await this.records.recordConflictConnectedPerson({ clientId, ...input, actorId: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.conflict_connected_person_added',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { personId: created.id, name: input.name, relationship: input.relationship },
          ...by.context,
        }, trx);
        return created;
      });
      return { outcome: 'recorded', person };
    } catch (error) {
      if (hasCode(error, '42501') || hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listConflictConnectedPersons(clientId: string): Promise<ConflictConnectedPerson[]> {
    return this.records.listConflictConnectedPersons(clientId);
  }

  async recordConflictDecision(
    clientId: string,
    checkId: string,
    input: {
      outcome: 'clear' | 'potential' | 'escalated' | 'approved_with_controls' | 'cannot_act';
      rationale: string;
      safeguards: string[];
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded'; decisionId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      const decisionId = await this.records.transaction(async (trx) => {
        const id = await this.records.recordConflictDecision({
          clientId,
          checkId,
          outcome: input.outcome,
          rationale: input.rationale,
          safeguards: input.safeguards,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.conflict_decision_recorded',
          outcome: 'success',
          resource: { type: 'conflict_decision', id },
          metadata: { clientId, checkId, outcome: input.outcome, safeguardsCount: input.safeguards.length },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'recorded', decisionId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listConflictDecisions(clientId: string, checkId?: string): Promise<ConflictDecision[]> {
    return this.records.listConflictDecisions(clientId, checkId);
  }

  async listClientConflictChecks(clientId: string) {
    return this.records.listConflictChecksForClient(clientId);
  }

  async grantActivationException(
    clientId: string,
    input: {
      requirementKey: 'conflict_check' | 'email_verification' | 'id_verification' | 'cdd_compliance';
      reason: string;
      expiresAt: Date;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded'; exceptionId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      const exceptionId = await this.records.transaction(async (trx) => {
        const id = await this.records.grantActivationException({
          clientId,
          requirementKey: input.requirementKey,
          reason: input.reason,
          expiresAt: input.expiresAt,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.activation_exception_granted',
          outcome: 'success',
          resource: { type: 'activation_exception', id },
          metadata: { clientId, requirementKey: input.requirementKey, expiresAt: input.expiresAt.toISOString() },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'recorded', exceptionId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async listActivationExceptions(clientId: string): Promise<ActivationException[]> {
    return this.records.listActivationExceptions(clientId);
  }

  async getActivationGate(clientId: string): Promise<ActivationGate | null> {
    return this.records.evaluateActivationGate(clientId);
  }

  async activateClient(
    clientId: string,
    input: { notes: string | null },
    by: OnboardingActor,
  ): Promise<{ outcome: 'activated'; activationId: string } | { outcome: 'forbidden' | 'not_found' | 'blocked' }> {
    try {
      const activationId = await this.records.transaction(async (trx) => {
        const id = await this.records.activateClient({
          clientId,
          notes: input.notes,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.client_activated',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { activationId: id, notes: input.notes },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'activated', activationId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'blocked' };
      throw error;
    }
  }

  listEngagementTemplates(): Promise<EngagementTemplate[]> {
    return this.records.listEngagementTemplates();
  }

  getEngagementTemplate(id: string): Promise<EngagementTemplate | null> {
    return this.records.getEngagementTemplate(id);
  }

  async createEngagementTemplate(
    input: { templateKey: string; title: string; bodyMarkdown: string; allowedFields: string[] },
    by: OnboardingActor,
  ): Promise<{ outcome: 'created'; templateId: string } | { outcome: 'forbidden' | 'conflict' }> {
    try {
      const templateId = await this.records.transaction(async (trx) => {
        const id = await this.records.createEngagementTemplate({
          templateKey: input.templateKey,
          title: input.title,
          bodyMarkdown: input.bodyMarkdown,
          allowedFields: input.allowedFields,
          actorId: by.accountId,
        }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_template_created',
          outcome: 'success',
          resource: { type: 'engagement_template', id },
          metadata: { templateKey: input.templateKey, title: input.title },
          ...by.context,
        }, trx);
        return id;
      });
      return { outcome: 'created', templateId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  listClientEngagementDocuments(clientId: string): Promise<EngagementDocument[]> {
    return this.records.listClientEngagementDocuments(clientId);
  }

  getEngagementDocument(documentId: string): Promise<EngagementDocument | null> {
    return this.records.getEngagementDocument(documentId);
  }

  async generateEngagementDocument(
    input: {
      clientId: string;
      matterId: string | null;
      templateId: string;
      title: string;
      fields: Record<string, string>;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'generated'; documentId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    const template = await this.records.getEngagementTemplate(input.templateId);
    if (!template) return { outcome: 'not_found' };

    const allowed = new Set(template.allowedFields);
    const sanitizedSnapshot: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields)) {
      if (allowed.has(k)) {
        sanitizedSnapshot[k] = String(v ?? '').trim();
      }
    }

    let rendered = template.bodyMarkdown;
    for (const [k, v] of Object.entries(sanitizedSnapshot)) {
      rendered = rendered.split(`{{${k}}}`).join(v);
    }

    const contentHash = createHash('sha256').update(rendered, 'utf8').digest('hex');

    try {
      const documentId = await this.records.transaction(async (trx) => {
        const id = await this.records.generateEngagementDocument({
          clientId: input.clientId,
          matterId: input.matterId,
          templateId: input.templateId,
          title: input.title,
          inputSnapshot: sanitizedSnapshot,
          renderedContent: rendered,
          contentHash,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_document_generated',
          outcome: 'success',
          resource: { type: 'client', id: input.clientId },
          metadata: { documentId: id, documentKind: template.templateKey, title: input.title, contentHash },
          ...by.context,
        }, trx);

        return id;
      });

      return { outcome: 'generated', documentId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
      if (hasCode(error, '23505') || hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async sendEngagementDocument(
    documentId: string,
    input: { expiresAt: Date | null },
    by: OnboardingActor,
  ): Promise<{ outcome: 'sent' } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      await this.records.transaction(async (trx) => {
        await this.records.sendEngagementDocument({
          documentId,
          expiresAt: input.expiresAt,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_document_sent',
          outcome: 'success',
          resource: { type: 'engagement_document', id: documentId },
          metadata: { expiresAt: input.expiresAt?.toISOString() ?? null },
          ...by.context,
        }, trx);
      });

      return { outcome: 'sent' };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async recordEngagementSignature(
    documentId: string,
    input: {
      signerName: string;
      signerEmail: string | null;
      signerRole: SignerRole;
      signatureMethod: SignatureMethod;
      documentIdRef: string | null;
      metadata?: Record<string, unknown>;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded'; signatureId: string } | { outcome: 'not_found' | 'conflict' }> {
    try {
      const signatureId = await this.records.transaction(async (trx) => {
        const id = await this.records.recordEngagementSignature({
          documentId,
          signerName: input.signerName,
          signerEmail: input.signerEmail,
          signerRole: input.signerRole,
          signatureMethod: input.signatureMethod,
          documentIdRef: input.documentIdRef,
          metadata: input.metadata ?? {},
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_signature_recorded',
          outcome: 'success',
          resource: { type: 'engagement_document', id: documentId },
          metadata: { signatureId: id, signerName: input.signerName, signatureMethod: input.signatureMethod },
          ...by.context,
        }, trx);

        return id;
      });

      return { outcome: 'recorded', signatureId };
    } catch (error) {
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async declineEngagementDocument(
    documentId: string,
    input: { reason: string },
    by: OnboardingActor,
  ): Promise<{ outcome: 'declined' } | { outcome: 'not_found' | 'conflict' }> {
    try {
      await this.records.transaction(async (trx) => {
        await this.records.declineEngagementDocument({
          documentId,
          reason: input.reason,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_document_declined',
          outcome: 'success',
          resource: { type: 'engagement_document', id: documentId },
          metadata: { reason: input.reason },
          ...by.context,
        }, trx);
      });

      return { outcome: 'declined' };
    } catch (error) {
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async reviewEngagementSignature(
    signatureId: string,
    input: { outcome: 'accepted' | 'rejected'; reason: string },
    by: OnboardingActor,
  ): Promise<{ outcome: 'reviewed'; reviewId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      const reviewId = await this.records.transaction(async (trx) => {
        const id = await this.records.reviewEngagementSignature({
          signatureId,
          outcome: input.outcome,
          reason: input.reason,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.engagement_signature_reviewed',
          outcome: 'success',
          resource: { type: 'engagement_signature', id: signatureId },
          metadata: { reviewId: id, reviewOutcome: input.outcome, reason: input.reason },
          ...by.context,
        }, trx);

        return id;
      });

      return { outcome: 'reviewed', reviewId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  listPortalEngagementDocuments(accountId: string): Promise<EngagementDocument[]> {
    return this.records.listPortalEngagementDocuments(accountId);
  }

  async getPortalEngagementDocument(documentId: string, accountId: string): Promise<EngagementDocument | null> {
    const list = await this.records.listPortalEngagementDocuments(accountId);
    const doc = list.find((d) => d.id === documentId);
    if (!doc) return null;
    if (doc.state === 'sent') {
      await this.records.markEngagementDocumentViewed(documentId);
      doc.state = 'viewed';
      doc.viewedAt = new Date();
    }
    return doc;
  }

  async createMatterFeeEstimate(
    matterId: string,
    input: {
      chargingBasis: MatterChargingBasis;
      estimatedFeesPence: number | bigint | string;
      estimatedDisbursementsPence?: number | bigint | string;
      estimatedVatPence?: number | bigint | string;
      budgetLimitPence?: number | bigint | string | null;
      assumptions: string;
      agreedWithClient?: boolean;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'created'; estimateId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      const estimateId = await this.records.transaction(async (trx) => {
        const id = await this.records.createMatterFeeEstimate({
          matterId,
          chargingBasis: input.chargingBasis,
          estimatedFeesPence: input.estimatedFeesPence,
          estimatedDisbursementsPence: input.estimatedDisbursementsPence ?? 0,
          estimatedVatPence: input.estimatedVatPence ?? 0,
          budgetLimitPence: input.budgetLimitPence ?? null,
          assumptions: input.assumptions,
          agreedWithClient: input.agreedWithClient ?? true,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.fee_estimate_created',
          outcome: 'success',
          resource: { type: 'matter_fee_estimate', id },
          metadata: {
            matterId,
            chargingBasis: input.chargingBasis,
            estimatedFeesPence: String(input.estimatedFeesPence),
          },
          ...by.context,
        }, trx);

        return id;
      });

      return { outcome: 'created', estimateId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  listMatterFeeEstimates(matterId: string): Promise<MatterFeeEstimate[]> {
    return this.records.listMatterFeeEstimates(matterId);
  }

  async createOnboardingPaymentRequest(
    clientId: string,
    input: {
      matterId?: string | null;
      engagementDocumentId?: string | null;
      kind: OnboardingPaymentRequestKind;
      description: string;
      amountPence: number | bigint | string;
      dueOn: string;
      bankAccountDetails?: Record<string, unknown> | null;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'created'; requestId: string } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      const requestId = await this.records.transaction(async (trx) => {
        const id = await this.records.createOnboardingPaymentRequest({
          clientId,
          matterId: input.matterId ?? null,
          engagementDocumentId: input.engagementDocumentId ?? null,
          kind: input.kind,
          description: input.description,
          amountPence: input.amountPence,
          dueOn: input.dueOn,
          bankAccountDetails: input.bankAccountDetails ?? null,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.payment_request_created',
          outcome: 'success',
          resource: { type: 'onboarding_payment_request', id },
          metadata: {
            clientId,
            matterId: input.matterId ?? null,
            kind: input.kind,
            amountPence: String(input.amountPence),
          },
          ...by.context,
        }, trx);

        return id;
      });

      return { outcome: 'created', requestId };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  listClientPaymentRequests(clientId: string): Promise<OnboardingPaymentRequest[]> {
    return this.records.listClientPaymentRequests(clientId);
  }

  listPortalPaymentRequests(accountId: string): Promise<PortalPaymentRequest[]> {
    return this.records.listPortalPaymentRequests(accountId);
  }

  async recordOnboardingPaymentReceipt(
    requestId: string,
    input: {
      paymentMethod: OnboardingPaymentMethod;
      reference: string;
      notes?: string | null;
    },
    by: OnboardingActor,
  ): Promise<{ outcome: 'recorded' } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      await this.records.transaction(async (trx) => {
        await this.records.recordOnboardingPaymentReceipt({
          requestId,
          paymentMethod: input.paymentMethod,
          reference: input.reference,
          notes: input.notes ?? null,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.payment_receipt_recorded',
          outcome: 'success',
          resource: { type: 'onboarding_payment_request', id: requestId },
          metadata: {
            paymentMethod: input.paymentMethod,
            reference: input.reference,
          },
          ...by.context,
        }, trx);
      });

      return { outcome: 'recorded' };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  async waiveOnboardingPaymentRequest(
    requestId: string,
    input: { reason: string },
    by: OnboardingActor,
  ): Promise<{ outcome: 'waived' } | { outcome: 'forbidden' | 'not_found' | 'conflict' }> {
    try {
      await this.records.transaction(async (trx) => {
        await this.records.waiveOnboardingPaymentRequest({
          requestId,
          reason: input.reason,
          actorId: by.accountId,
        }, trx);

        await this.audit.record({
          actor: by.actor,
          action: 'onboarding.payment_request_waived',
          outcome: 'success',
          resource: { type: 'onboarding_payment_request', id: requestId },
          metadata: { reason: input.reason },
          ...by.context,
        }, trx);
      });

      return { outcome: 'waived' };
    } catch (error) {
      if (hasCode(error, '42501')) return { outcome: 'forbidden' };
      if (hasCode(error, 'P0002')) return { outcome: 'not_found' };
      if (hasCode(error, '23514')) return { outcome: 'conflict' };
      throw error;
    }
  }

  private verificationLink(token: string): string {
    const link = new URL('/verify-contact', this.env.APP_BASE_URL);
    link.hash = `token=${token}`;
    return link.toString();
  }
}

function verificationEmail(link: string): string {
  return ['Hello,', '', 'Your law firm asked you to confirm that you control this email address.',
    'Open this one-time link within 24 hours:', '', link, '',
    'This confirms the email channel only. It does not verify your identity or complete any legal or AML check.',
    'If you were not expecting this request, do not open the link and contact the firm independently.'].join('\n');
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
