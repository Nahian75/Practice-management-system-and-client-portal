import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { DocumentMediaType } from '../database/schema.js';
import { FileInspection, FileRefusedError, type RefusalReason } from '../documents/file-inspection.js';
import { UploadFormError } from '../documents/upload-request.js';
import { isLimitsAlert, VirusScanner } from '../documents/virus-scanner.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { ComplianceRepository } from './compliance.repository.js';
import type { ComplianceActor } from './compliance.service.js';
import { RestrictedReportsRepository, type AttachmentRow, type SealedRow } from './restricted-reports.repository.js';
import type { RestrictedReport } from './restricted-reports.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';
import { SuspicionEvidenceVault, type StoredSuspicionEvidence } from './suspicion-evidence-vault.js';

type Refusal = RefusalReason | 'malware' | 'scanner_unavailable' | 'unscannable' | 'form' | 'interrupted';
interface Received { inspected: { mediaType: DocumentMediaType; sizeBytes: number; sha256: Buffer }; stored: StoredSuspicionEvidence }
export type RestrictedChange<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };
export type SubmitOutcome = { outcome: 'submitted'; receiptId: string }
  | { outcome: 'not_found' | 'conflict' } | { outcome: 'refused'; reason: Refusal };

@Injectable()
export class RestrictedReportsService {
  constructor(private readonly records: RestrictedReportsRepository, private readonly complianceRecords: ComplianceRepository,
    private readonly audit: AuditService, private readonly cipher: SuspicionDataCipher,
    private readonly amlCipher: ComplianceDataCipher, private readonly vault: SuspicionEvidenceVault,
    private readonly scanner: VirusScanner) {}

  async submit(input: { clientId: string; matterId: string | null; financeTransactionId: string | null;
    observedOn: string; observedFacts: string; attachment?: { fileName: string; file: Readable } },
    by: ComplianceActor): Promise<SubmitOutcome> {
    let received: Received | undefined;
    if (input.attachment) {
      const result = await this.receive(input.attachment.fileName, input.attachment.file);
      if ('reason' in result) return { outcome: 'refused', reason: result.reason };
      received = result;
    }
    try {
      const id = await this.records.transaction(async (trx) => {
        const reportId = await this.records.newId(trx);
        await this.records.submit({ id: reportId, clientId: input.clientId, matterId: input.matterId,
          transactionId: input.financeTransactionId, observedOn: input.observedOn,
          sealed: this.cipher.seal({ observedFacts: input.observedFacts }, `suspicion-report:${reportId}`),
          actorId: by.accountId }, trx);
        if (received && input.attachment) {
          const attachmentId = await this.records.newId(trx);
          await this.records.addAttachment({ id: attachmentId, reportId,
            metadata: this.cipher.seal({ fileName: input.attachment.fileName }, `suspicion-attachment:${attachmentId}`),
            mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes,
            sha256: received.inspected.sha256, storageKey: received.stored.storageKey,
            fileKey: received.stored.sealedKey, actorId: by.accountId }, trx);
        }
        await this.changed(reportId, by, trx);
        return reportId;
      });
      return { outcome: 'submitted', receiptId: id };
    } catch (error) {
      if (received) await this.vault.discard(received.stored.storageKey);
      if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
      if (['23505', '23514', '42501', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
      throw error;
    }
  }

  async list(actorId: string, before?: string) {
    const items = await this.records.list(actorId, before);
    return { items, next: items.length === 100 ? items.at(-1)!.id : null };
  }

  async find(id: string, actorId: string): Promise<RestrictedReport | undefined> {
    return this.records.transaction(async (trx) => {
      const row = await this.records.read(id, actorId, trx);
      if (!row) return undefined;
      const [attachments, decision, external] = await Promise.all([
        this.records.attachments(id, actorId, trx), this.records.decision(id, actorId, trx), this.records.external(id, actorId, trx),
      ]);
      const events = external ? await this.records.events(external.id, actorId, trx) : [];
      return {
        id: row.id, clientId: row.client_id, matterId: row.matter_id, financeTransactionId: row.finance_transaction_id,
        observedOn: row.observed_on, observedFacts: this.open<{ observedFacts: string }>(row).observedFacts,
        submittedBy: row.submitted_by, submittedAt: row.submitted_at,
        attachments: attachments.map((a) => ({ id: a.id, fileName: this.attachmentName(a), mediaType: a.media_type,
          sizeBytes: a.size_bytes, uploadedAt: a.uploaded_at })),
        decision: decision ? { id: decision.id, externalReportRequired: decision.external_report_required,
          legalGrounds: this.open<{ legalGrounds: string }>(decision).legalGrounds,
          decidedBy: decision.decided_by, decidedAt: decision.decided_at } : null,
        externalReport: external ? { id: external.id, kind: external.report_kind,
          damlDatfRequested: external.daml_datf_requested,
          reference: this.open<{ reference: string }>(external).reference, submittedAt: external.submitted_at,
          recordedAt: external.recorded_at, submittedBy: external.submitted_by,
          events: events.map((event) => ({ id: event.id, outcome: event.outcome, receivedAt: event.received_at,
            expiresAt: event.expires_at, ...this.open<{ externalReference: string; permittedActivity: string | null;
              legalBasis: string }>(event), recordedBy: event.recorded_by, recordedAt: event.recorded_at })) } : null,
      };
    });
  }

  async decide(reportId: string, input: { externalReportRequired: boolean; legalGrounds: string; imposeHold: boolean },
    by: ComplianceActor): Promise<RestrictedChange<RestrictedReport>> {
    try {
      await this.records.transaction(async (trx) => {
        const report = await this.records.read(reportId, by.accountId, trx);
        if (!report) throw new MissingRestrictedRecord();
        let holdId: string | null = null;
        if (input.imposeHold) {
          holdId = await this.complianceRecords.newId(trx);
          await this.complianceRecords.imposeHold({ id: holdId, clientId: report.matter_id ? null : report.client_id,
            matterId: report.matter_id, sealed: this.amlCipher.seal({ text: 'Protected compliance review' }, `aml-hold:${holdId}`),
            actorId: by.accountId }, trx);
        }
        const id = await this.records.newId(trx);
        await this.records.decide({ id, reportId, required: input.externalReportRequired,
          sealed: this.cipher.seal({ legalGrounds: input.legalGrounds }, `suspicion-decision:${id}`),
          holdId, actorId: by.accountId }, trx);
        await this.changed(reportId, by, trx);
      });
      return { outcome: 'changed', value: (await this.find(reportId, by.accountId))! };
    } catch (error) { return this.outcome(error); }
  }

  async recordExternal(reportId: string, input: { kind: 'sar' | 'terrorist_financing_report'; reference: string;
    submittedAt: string; damlDatfRequested: boolean }, by: ComplianceActor): Promise<RestrictedChange<RestrictedReport>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.recordExternal({ id, reportId, kind: input.kind, requested: input.damlDatfRequested,
          submittedAt: input.submittedAt, sealed: this.cipher.seal({ reference: input.reference }, `external-report:${id}`),
          actorId: by.accountId }, trx);
        await this.changed(reportId, by, trx);
      });
      return { outcome: 'changed', value: (await this.find(reportId, by.accountId))! };
    } catch (error) { return this.outcome(error); }
  }

  async recordEvent(reportId: string, externalId: string, input: { outcome: 'requested' | 'granted' | 'refused' | 'withdrawn' | 'expired';
    receivedAt: string; expiresAt: string | null; externalReference: string; permittedActivity: string | null; legalBasis: string },
    by: ComplianceActor): Promise<RestrictedChange<RestrictedReport>> {
    try {
      await this.records.transaction(async (trx) => {
        const external = await this.records.external(reportId, by.accountId, trx);
        if (!external || external.id !== externalId) throw new MissingRestrictedRecord();
        const id = await this.records.newId(trx);
        await this.records.recordEvent({ id, externalId, outcome: input.outcome, receivedAt: input.receivedAt,
          expiresAt: input.expiresAt, sealed: this.cipher.seal({ externalReference: input.externalReference,
            permittedActivity: input.permittedActivity, legalBasis: input.legalBasis }, `daml-datf-event:${id}`),
          actorId: by.accountId }, trx);
        await this.changed(reportId, by, trx);
      });
      return { outcome: 'changed', value: (await this.find(reportId, by.accountId))! };
    } catch (error) { return this.outcome(error); }
  }

  async download(reportId: string, attachmentId: string, actorId: string) {
    const report = await this.find(reportId, actorId);
    if (!report?.attachments.some((item) => item.id === attachmentId)) return undefined;
    const row = await this.records.attachmentForDownload(attachmentId, actorId);
    if (!row) return undefined;
    const fileName = this.attachmentName(row);
    const file = await this.vault.open({ storageKey: row.storage_key, sealedKey: { keyVersion: row.file_key_version,
      nonce: row.file_key_nonce, ciphertext: row.wrapped_file_key, authTag: row.file_key_tag } });
    return { file, fileName, mediaType: row.media_type, sizeBytes: row.size_bytes };
  }

  accessLog(reportId: string, actorId: string) { return this.records.accessLog(reportId, actorId); }

  private open<T>(row: SealedRow): T {
    return this.cipher.open<T>({ context: row.encryption_context, keyVersion: row.key_version,
      nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag });
  }
  private attachmentName(row: AttachmentRow): string {
    return this.cipher.open<{ fileName: string }>({ context: row.metadata_context, keyVersion: row.metadata_key_version,
      nonce: row.metadata_nonce, ciphertext: row.metadata_ciphertext, authTag: row.metadata_auth_tag }).fileName;
  }
  private changed(reportId: string, by: ComplianceActor, trx: Parameters<AuditService['record']>[1]) {
    return this.audit.record({ actor: by.actor, action: 'compliance.restricted_record_changed', outcome: 'success',
      resource: { type: 'compliance_restricted_record', id: reportId }, metadata: {}, ...by.context }, trx);
  }
  private outcome(error: unknown): RestrictedChange<never> {
    if (error instanceof MissingRestrictedRecord || hasCode(error, 'P0002') || hasCode(error, '23503') || hasCode(error, '42501')) return { outcome: 'not_found' };
    if (['23505', '23514', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
    throw error;
  }

  private async receive(fileName: string, file: Readable): Promise<Received | { reason: Refusal }> {
    const inspection = new FileInspection(fileName);
    const toScanner = new PassThrough();
    const toVault = new PassThrough();
    let first: { origin: 'file' | 'inspection' | 'scanner' | 'storage'; error: unknown } | undefined;
    const stop = (origin: NonNullable<typeof first>['origin']) => (error: unknown) => {
      first ??= { origin, error };
      const reason = error instanceof Error ? error : new Error('Upload stopped');
      inspection.destroy(reason); toScanner.destroy(reason); toVault.destroy(reason);
    };
    file.on('error', stop('file')); inspection.on('error', stop('inspection'));
    toScanner.on('error', () => undefined); toVault.on('error', () => undefined);
    file.pipe(inspection); inspection.pipe(toScanner); inspection.pipe(toVault);
    const scanning = this.scanner.scan(toScanner), storing = this.vault.store(toVault);
    scanning.catch(stop('scanner')); storing.catch(stop('storage'));
    const [scan, store] = await Promise.allSettled([scanning, storing]);
    let reason: Refusal | undefined;
    if (first?.origin === 'inspection' && first.error instanceof FileRefusedError) reason = first.error.reason;
    else if (first?.origin === 'scanner') reason = 'scanner_unavailable';
    else if (first?.origin === 'file') reason = first.error instanceof UploadFormError ? 'form' : 'interrupted';
    else if (!first && scan.status === 'fulfilled' && !scan.value.clean) reason = isLimitsAlert(scan.value.signature) ? 'unscannable' : 'malware';
    if (reason || first) {
      if (store.status === 'fulfilled') await this.vault.discard(store.value.storageKey);
      if (reason) return { reason };
      throw first!.error;
    }
    if (scan.status === 'rejected' || store.status === 'rejected') throw new Error('Restricted upload ended without an answer');
    return { inspected: inspection.result(), stored: store.value };
  }
}

class MissingRestrictedRecord extends Error {}
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
