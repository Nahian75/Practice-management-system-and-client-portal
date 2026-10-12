import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { HrCorrectionCategory, HrEngagementKind, HrFileCategory } from '../database/schema.js';
import type { Database } from '../database/schema.js';
import { FileInspection, FileRefusedError, type RefusalReason } from '../documents/file-inspection.js';
import { UploadFormError } from '../documents/upload-request.js';
import { isLimitsAlert, VirusScanner } from '../documents/virus-scanner.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrFileVault } from './hr-file-vault.js';
import { HrRepository, type CorrectionRow, type HrFileRow, type SealedHrRow } from './hr.repository.js';
import type { HrContactDetails, HrCorrection, HrFileSummary, HrPersonSummary,
  HrPrivateDetails, HrWorkPatternInput } from './hr.js';

export interface HrActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type HrChange<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };
export type HrUploadRefusal = RefusalReason | 'scanner_unavailable' | 'unscannable' | 'malware' | 'form' | 'interrupted';
export class HrUploadRefusedError extends Error {
  override readonly name = 'HrUploadRefusedError';
  constructor(readonly reason: HrUploadRefusal) { super('The HR file was refused'); }
}

const EMPTY_CONTACT: HrContactDetails = {
  personalEmail: null, phone: null, address: null, emergencyContact: null,
};
const EMPTY_PRIVATE: HrPrivateDetails = { dateOfBirth: null };

@Injectable()
export class HrService {
  constructor(
    private readonly records: HrRepository,
    private readonly cipher: HrDataCipher,
    private readonly files: HrFileVault,
    private readonly audit: AuditService,
    private readonly scanner: VirusScanner,
  ) {}

  directory(actorId: string) { return this.records.directory(actorId); }

  reports(actorId: string) { return this.records.reports(actorId); }

  async listPeople(actorId: string) {
    return (await this.records.people(actorId)).map((row) => ({
      personId: row.person_id, accountId: row.account_id, displayName: row.display_name,
      workEmail: row.work_email, accountStatus: row.account_status,
      engagementId: row.engagement_id, engagementKind: row.engagement_kind,
      startedOn: row.started_on, endedOn: row.ended_on, jobTitle: row.job_title,
      team: row.team, workLocation: row.work_location,
    }));
  }

  async self(by: HrActor) {
    const personId = await this.records.ownPersonId(by.accountId);
    return personId ? this.record(personId, by) : undefined;
  }

  ownPersonId(accountId: string) { return this.records.ownPersonId(accountId); }

  record(personId: string, by: HrActor) { return this.fullRecord(personId, by); }

  async report(personId: string, actorId: string) {
    try {
      const row = await this.records.summary(personId, actorId);
      if (!row) return undefined;
      const summary = mapSummary(row);
      if (summary.accessKind !== 'manager') return summary;
      const patterns = await this.records.workPatterns(personId, actorId);
      return { ...summary, workPattern: patterns[0] ? mapPattern(patterns[0]) : null };
    } catch (error) {
      if (hidden(error)) return undefined;
      throw error;
    }
  }

  async createPerson(input: { accountId: string; contact?: HrContactDetails; privateDetails?: HrPrivateDetails }, by: HrActor): Promise<HrChange<unknown>> {
    try {
      const personId = await this.records.transaction(async (trx) => {
        const created = await this.records.createPerson(input.accountId, by.accountId, trx);
        if (input.contact) {
          const id = await this.records.newId(trx);
          await this.records.recordContact(id, created, this.cipher.seal(input.contact, `hr-contact:${id}`), by.accountId, trx);
        }
        if (input.privateDetails) {
          const id = await this.records.newId(trx);
          await this.records.recordPrivate(id, created, this.cipher.seal(input.privateDetails, `hr-private:${id}`), by.accountId, trx);
        }
        await this.audit.record({ actor: by.actor, action: 'hr.person_created', outcome: 'success',
          resource: { type: 'hr_person', id: created }, metadata: { accountId: input.accountId }, ...by.context }, trx);
        return created;
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async updateContact(personId: string, value: HrContactDetails, by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.recordContact(id, personId, this.cipher.seal(value, `hr-contact:${id}`), by.accountId, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.contact_updated', outcome: 'success',
          resource: { type: 'hr_person', id: personId }, metadata: {}, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async updatePrivate(personId: string, value: HrPrivateDetails, by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.recordPrivate(id, personId, this.cipher.seal(value, `hr-private:${id}`), by.accountId, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.private_details_updated', outcome: 'success',
          resource: { type: 'hr_person', id: personId }, metadata: {}, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async createEngagement(personId: string, input: { kind: HrEngagementKind; startedOn: string;
    jobTitle: string; team: string | null; workLocation: string | null; pattern: HrWorkPatternInput },
    by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.createEngagement({ personId, ...input, actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.engagement_created', outcome: 'success',
          resource: { type: 'hr_engagement', id }, metadata: { personId, kind: input.kind }, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async updateTerms(personId: string, input: { engagementId: string; effectiveOn: string; jobTitle: string;
    team: string | null; workLocation: string | null }, by: HrActor): Promise<HrChange<unknown>> {
    return this.changeAndRead(personId, 'hr.terms_recorded', { effectiveOn: input.effectiveOn }, by,
      (trx) => this.records.recordTerms({ personId, ...input, actorId: by.accountId }, trx));
  }

  async updatePattern(personId: string, input: { engagementId: string; effectiveOn: string;
    pattern: HrWorkPatternInput }, by: HrActor): Promise<HrChange<unknown>> {
    return this.changeAndRead(personId, 'hr.work_pattern_recorded', { effectiveOn: input.effectiveOn }, by,
      (trx) => this.records.recordWorkPattern({ personId, ...input, actorId: by.accountId }, trx));
  }

  async updateManager(personId: string, input: { managerPersonId: string | null; effectiveOn: string },
    by: HrActor): Promise<HrChange<unknown>> {
    return this.changeAndRead(personId, 'hr.manager_recorded',
      { effectiveOn: input.effectiveOn, assigned: input.managerPersonId !== null }, by,
      (trx) => this.records.recordManager({ personId, ...input, actorId: by.accountId }, trx));
  }

  async endEngagement(personId: string, input: { engagementId: string; endedOn: string; reason: string },
    by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const endingId = await this.records.newId(trx);
        await this.records.endEngagement({ personId, engagementId: input.engagementId, endingId, endedOn: input.endedOn,
          sealed: this.cipher.seal({ reason: input.reason }, `hr-engagement-ending:${endingId}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.engagement_ended', outcome: 'success',
          resource: { type: 'hr_engagement', id: input.engagementId }, metadata: { personId, endedOn: input.endedOn },
          ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async requestCorrection(personId: string, input: { category: HrCorrectionCategory; request: string },
    by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.createCorrection({ id, personId, category: input.category,
          sealed: this.cipher.seal({ request: input.request }, `hr-correction:${id}`), actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.correction_requested', outcome: 'success',
          resource: { type: 'hr_correction', id }, metadata: { personId, category: input.category }, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async listCorrections(actorId: string): Promise<Array<HrCorrection & { accountId: string; displayName: string }>> {
    return (await this.records.allCorrections(actorId)).map((row) => ({
      ...this.mapCorrection(row), accountId: row.account_id!, displayName: row.display_name!,
    }));
  }

  async decideCorrection(personId: string, requestId: string, input: { outcome: 'resolved' | 'rejected'; response: string },
    by: HrActor): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const eventId = await this.records.newId(trx);
        await this.records.decideCorrection({ personId, eventId, requestId, outcome: input.outcome,
          sealed: this.cipher.seal({ response: input.response }, `hr-correction-event:${eventId}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.correction_decided', outcome: 'success',
          resource: { type: 'hr_correction', id: requestId }, metadata: { personId, outcome: input.outcome }, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  async upload(personId: string, input: { category: HrFileCategory; workerVisible: boolean;
    fileName: string; file: Readable }, by: HrActor): Promise<HrChange<unknown>> {
    const received = await this.receive(input.fileName, input.file);
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.recordFile({ id, personId, category: input.category,
          workerVisible: input.workerVisible, metadata: this.cipher.seal({ fileName: input.fileName }, `hr-file-metadata:${id}`),
          mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes,
          sha256: received.inspected.sha256, storageKey: received.stored.storageKey,
          fileKey: received.stored.sealedKey, actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'hr.file_uploaded', outcome: 'success',
          resource: { type: 'hr_file', id }, metadata: { personId, category: input.category,
            mediaType: received.inspected.mediaType, sizeBytes: received.inspected.sizeBytes,
            workerVisible: input.workerVisible }, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) {
      await this.files.discard(received.stored.storageKey);
      return this.changeError(error);
    }
  }

  async download(personId: string, fileId: string, by: HrActor) {
    try {
      const row = await this.records.transaction(async (trx) => {
        const found = await this.records.file(fileId, personId, by.accountId, trx);
        if (!found) return undefined;
        await this.audit.record({ actor: by.actor, action: 'hr.file_downloaded', outcome: 'success',
          resource: { type: 'hr_file', id: fileId }, metadata: { personId }, ...by.context }, trx);
        return found;
      });
      if (!row) return undefined;
      return { file: await this.files.open({ storageKey: row.storage_key, sealedKey: {
        keyVersion: row.file_key_version, nonce: row.file_key_nonce,
        ciphertext: row.wrapped_file_key, authTag: row.file_key_tag,
      } }), fileName: this.fileName(row), mediaType: row.media_type, sizeBytes: row.size_bytes };
    } catch (error) {
      if (hidden(error)) return undefined;
      throw error;
    }
  }

  private async fullRecord(personId: string, by: HrActor) {
    try {
      return await this.records.transaction(async (trx) => {
        const row = await this.records.summary(personId, by.accountId, trx);
        if (!row || row.access_kind === 'manager') return undefined;
        const [contact, privateDetails, engagements, terms, managers, patterns, corrections, files] = await Promise.all([
          this.records.contact(personId, by.accountId, trx), this.records.privateDetails(personId, by.accountId, trx),
          this.records.engagements(personId, by.accountId, trx), this.records.terms(personId, by.accountId, trx),
          this.records.managers(personId, by.accountId, trx), this.records.workPatterns(personId, by.accountId, trx),
          this.records.corrections(personId, by.accountId, trx), this.records.files(personId, by.accountId, trx),
        ]);
        if (row.access_kind === 'hr' && row.account_id !== by.accountId) {
          await this.audit.record({ actor: by.actor, action: 'hr.record_viewed', outcome: 'success',
            resource: { type: 'hr_person', id: personId }, metadata: {}, ...by.context }, trx);
        }
        return {
          ...mapSummary(row),
          contact: contact ? this.open<HrContactDetails>(contact) : EMPTY_CONTACT,
          privateDetails: privateDetails ? this.open<HrPrivateDetails>(privateDetails) : EMPTY_PRIVATE,
          engagements: engagements.map((item) => ({ id: item.id, kind: item.engagement_kind,
            startedOn: item.started_on, endedOn: item.ended_on, createdBy: item.created_by,
            createdAt: item.created_at })),
          terms: terms.map((item) => ({ id: item.id, engagementId: item.engagement_id,
            effectiveOn: item.effective_on, jobTitle: item.job_title, team: item.team,
            workLocation: item.work_location, recordedBy: item.recorded_by, recordedAt: item.recorded_at })),
          managerEvents: managers.map((item) => ({ id: item.id, action: item.action,
            managerPersonId: item.manager_person_id, effectiveOn: item.effective_on,
            recordedBy: item.recorded_by, recordedAt: item.recorded_at })),
          workPatterns: patterns.map(mapPattern), corrections: corrections.map((item) => this.mapCorrection(item)),
          files: files.map((item) => this.mapFile(item)),
        };
      });
    } catch (error) {
      if (hidden(error)) return undefined;
      throw error;
    }
  }

  private async changeAndRead(personId: string, action: string,
    metadata: Record<string, string | boolean>, by: HrActor,
    change: (trx: Kysely<Database>) => Promise<string>): Promise<HrChange<unknown>> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await change(trx);
        await this.audit.record({ actor: by.actor, action, outcome: 'success', resource: { type: 'hr_person', id: personId },
          metadata: { ...metadata, historyId: id }, ...by.context }, trx);
      });
      return { outcome: 'changed', value: await this.fullRecord(personId, by) };
    } catch (error) { return this.changeError(error); }
  }

  private open<T>(row: SealedHrRow): T {
    return this.cipher.open<T>({ context: row.context, keyVersion: row.key_version,
      nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag });
  }

  private mapCorrection(row: CorrectionRow): HrCorrection {
    const request = this.open<{ request: string }>(row).request;
    const response = row.event_context && row.event_key_version && row.event_nonce
      && row.event_ciphertext && row.event_auth_tag
      ? this.cipher.open<{ response: string }>({ context: row.event_context,
        keyVersion: row.event_key_version, nonce: row.event_nonce,
        ciphertext: row.event_ciphertext, authTag: row.event_auth_tag }).response : null;
    return { id: row.id, personId: row.person_id, category: row.category, request,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at, outcome: row.outcome,
      response, decidedBy: row.decided_by, decidedAt: row.decided_at };
  }

  private mapFile(row: HrFileRow): HrFileSummary {
    return { id: row.id, category: row.category, workerVisible: row.worker_visible,
      fileName: this.fileName(row), mediaType: row.media_type, sizeBytes: row.size_bytes,
      uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at };
  }

  private fileName(row: HrFileRow): string {
    return this.cipher.open<{ fileName: string }>({ context: row.metadata_context,
      keyVersion: row.metadata_key_version, nonce: row.metadata_nonce,
      ciphertext: row.metadata_ciphertext, authTag: row.metadata_auth_tag }).fileName;
  }

  private changeError(error: unknown): HrChange<never> {
    if (hidden(error)) return { outcome: 'not_found' };
    if (['23505', '23514', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
    throw error;
  }

  private async receive(fileName: string, file: Readable) {
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
    const scanning = this.scanner.scan(toScanner), storing = this.files.store(toVault);
    scanning.catch(stop('scanner')); storing.catch(stop('storage'));
    const [scan, store] = await Promise.allSettled([scanning, storing]);
    let reason: HrUploadRefusal | undefined;
    if (first?.origin === 'inspection' && first.error instanceof FileRefusedError) reason = first.error.reason;
    else if (first?.origin === 'scanner') reason = 'scanner_unavailable';
    else if (first?.origin === 'file') reason = first.error instanceof UploadFormError ? 'form' : 'interrupted';
    else if (!first && scan.status === 'fulfilled' && !scan.value.clean) {
      reason = isLimitsAlert(scan.value.signature) ? 'unscannable' : 'malware';
    }
    if (reason || first) {
      if (store.status === 'fulfilled') await this.files.discard(store.value.storageKey);
      if (reason) throw new HrUploadRefusedError(reason);
      throw first!.error;
    }
    if (scan.status === 'rejected' || store.status === 'rejected') throw new Error('HR upload ended without an answer');
    return { inspected: inspection.result(), stored: store.value };
  }
}

function mapSummary(row: import('./hr.repository.js').SummaryRow): HrPersonSummary {
  return { personId: row.person_id, accountId: row.account_id, displayName: row.display_name,
    workEmail: row.work_email, accountStatus: row.account_status, accessKind: row.access_kind,
    engagementId: row.engagement_id, engagementKind: row.engagement_kind,
    startedOn: row.started_on, endedOn: row.ended_on, jobTitle: row.job_title,
    team: row.team, workLocation: row.work_location,
    manager: row.manager_person_id && row.manager_account_id && row.manager_name
      ? { personId: row.manager_person_id, accountId: row.manager_account_id, displayName: row.manager_name } : null };
}

function mapPattern(item: import('./hr.repository.js').WorkPatternRow) {
  return { id: item.id, engagementId: item.engagement_id, effectiveOn: item.effective_on,
    timeZone: item.time_zone, mondayMinutes: item.monday_minutes, tuesdayMinutes: item.tuesday_minutes,
    wednesdayMinutes: item.wednesday_minutes, thursdayMinutes: item.thursday_minutes,
    fridayMinutes: item.friday_minutes, saturdayMinutes: item.saturday_minutes,
    sundayMinutes: item.sunday_minutes, recordedBy: item.recorded_by, recordedAt: item.recorded_at };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function hidden(error: unknown): boolean { return hasCode(error, 'P0002') || hasCode(error, '42501') || hasCode(error, '23503'); }
