import { Inject, Injectable } from '@nestjs/common';
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
import type { ContactVerification, EvidenceRequest, PortalEvidenceRequest } from './onboarding.js';
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
