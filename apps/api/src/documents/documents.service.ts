import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SecurityNoticesService } from '../auth/notices/security-notices.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import { text } from '../common/validation/safe-text.js';
import { sql, type Kysely } from 'kysely';
import type { Database, DocumentCategory, DocumentMediaType } from '../database/schema.js';
import { reachedByComplianceAccess, visibleTo } from '../matters/matters.repository.js';
import { DocumentVault, type StoredFile } from './document-vault.js';
import { DocumentsRepository, type DocumentDetails, type DocumentSummary } from './documents.repository.js';
import { FileInspection, FileRefusedError, type InspectedFile, type RefusalReason } from './file-inspection.js';
import { discardUpload, UploadFormError } from './upload-request.js';
import { isLimitsAlert, VirusScanner, type ScanResult } from './virus-scanner.js';

/** The signed-in staff member acting, and the request it came from. */
export interface DocumentActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type UploadRefusal = RefusalReason | 'malware' | 'scanner_unavailable' | 'file_name' | 'form' | 'interrupted' | 'over_allowance';

export interface AddedDocument {
  id: string;
  title: string;
  category: DocumentCategory;
  createdAt: Date;
  version: { number: number; fileName: string; mediaType: DocumentMediaType; sizeBytes: number; uploadedAt: Date };
}

export type AddResult =
  | { outcome: 'added'; document: AddedDocument }
  | { outcome: 'not_found' | 'not_open' }
  | { outcome: 'refused'; reason: UploadRefusal };

export type AddVersionResult =
  | { outcome: 'added'; version: AddedDocument['version'] }
  | { outcome: 'not_found' | 'not_open' | 'withdrawn' }
  | { outcome: 'refused'; reason: UploadRefusal };

export type WithdrawResult = 'withdrawn' | 'not_found' | 'not_open' | 'already_withdrawn' | 'not_allowed' | 'changed';
export type ChangeSharingResult = 'changed' | 'unchanged' | 'not_found' | 'withdrawn' | 'changed_meanwhile';

interface AcceptedFile {
  fileName: string;
  inspected: InspectedFile;
  stored: StoredFile;
}

export const DOCUMENTS_PAGE_SIZE = 100;

/** Far beyond what one person adds in an hour of normal work (review D4). */
export const UPLOADS_PER_HOUR = 200;
export const UPLOAD_BYTES_PER_HOUR = 2 * 1024 ** 3;
export const UPLOAD_WINDOW_SECONDS = 60 * 60;

class OverAllowanceError extends Error {
  override readonly name = 'OverAllowanceError';
}

export type DownloadResult =
  | { outcome: 'ready'; file: Readable; fileName: string; mediaType: DocumentMediaType; sizeBytes: number }
  | { outcome: 'not_found' }
  | { outcome: 'withdrawn' };

type Received = { inspected: InspectedFile; stored: StoredFile } | { refusal: UploadRefusal; signature?: string };

const fileNameSchema = text(255);

@Injectable()
export class DocumentsService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly vault: DocumentVault,
    private readonly scanner: VirusScanner,
    private readonly audit: AuditService,
    private readonly notices: SecurityNoticesService,
  ) {}

  /**
   * Adds a document to a matter: the file is inspected, scanned and stored
   * encrypted as it arrives, and recorded only if all three succeed. Anything
   * refused leaves nothing stored and is audited; malware is also reported
   * to compliance.
   */
  async add(
    matterId: string,
    details: { title: string; category: DocumentCategory },
    upload: { fileName: string; file: Readable },
    by: DocumentActor,
  ): Promise<AddResult> {
    const matter = await this.documents.matterOnTeam(matterId, by.accountId);
    if (!matter || matter.status !== 'open') {
      discardUpload(upload.file);
      return { outcome: matter ? 'not_open' : 'not_found' };
    }
    const accepted = await this.accept({ matterId, matterReference: matter.reference }, upload, by, async (file, trx) => {
      const added = await this.documents.insert(
        { matterId, title: details.title, category: details.category, createdBy: by.accountId },
        { fileName: file.fileName, ...file.inspected, storageKey: file.stored.storageKey, sealedKey: file.stored.sealedKey },
        trx,
      );
      await this.recordVersion('document.added', added.id, matterId, added.version.number, file.inspected, by, trx);
      return added;
    });
    if (accepted.outcome !== 'accepted') {
      return accepted;
    }
    const { value: document, file } = accepted;
    return {
      outcome: 'added',
      document: {
        id: document.id,
        title: document.title,
        category: document.category,
        createdAt: document.created_at,
        version: { ...versionOf(file), number: document.version.number, uploadedAt: document.version.uploaded_at },
      },
    };
  }

  /** A new version of a document, checked and stored exactly as a first upload. Earlier versions are kept. */
  async addVersion(documentId: string, upload: { fileName: string; file: Readable }, by: DocumentActor): Promise<AddVersionResult> {
    const document = await this.documents.findForChange(documentId, by.accountId);
    if (!document || document.withdrawn || document.matterStatus !== 'open') {
      discardUpload(upload.file);
      return { outcome: !document ? 'not_found' : document.withdrawn ? 'withdrawn' : 'not_open' };
    }
    const accepted = await this.accept(
      { matterId: document.matterId, matterReference: document.matterReference },
      upload,
      by,
      async (file, trx) => {
        const version = await this.documents.insertVersion(
          documentId,
          { fileName: file.fileName, ...file.inspected, storageKey: file.stored.storageKey, sealedKey: file.stored.sealedKey },
          by.accountId,
          trx,
        );
        await this.recordVersion('document.version_added', documentId, document.matterId, version.number, file.inspected, by, trx);
        return version;
      },
    );
    if (accepted.outcome !== 'accepted') {
      return accepted;
    }
    return { outcome: 'added', version: { ...versionOf(accepted.file), number: accepted.value.number, uploadedAt: accepted.value.uploaded_at } };
  }

  /**
   * Withdraws a document added by mistake: by whoever added it, or by the
   * matter's supervising partner. It is kept, with its versions, but no
   * longer listed or downloaded. The reason is kept with the withdrawal,
   * not in the audit log.
   */
  async withdraw(documentId: string, reason: string, by: DocumentActor): Promise<WithdrawResult> {
    const document = await this.documents.findForChange(documentId, by.accountId);
    if (!document) {
      return 'not_found';
    }
    if (document.withdrawn) {
      return 'already_withdrawn';
    }
    if (document.matterStatus !== 'open') {
      return 'not_open';
    }
    if (document.createdBy !== by.accountId && !document.viewerSupervises) {
      return 'not_allowed';
    }
    try {
      await this.documents.transaction(async (trx) => {
        const stoppedSharing = await this.documents.withdraw(documentId, by.accountId, reason, trx);
        if (stoppedSharing) {
          await this.audit.record(
            {
              actor: by.actor,
              action: 'document.unshared',
              outcome: 'success',
              resource: { type: 'document', id: documentId },
              metadata: { matterId: document.matterId },
              ...by.context,
            },
            trx,
          );
        }
        await this.audit.record(
          {
            actor: by.actor,
            action: 'document.withdrawn',
            outcome: 'success',
            resource: { type: 'document', id: documentId },
            metadata: { matterId: document.matterId },
            ...by.context,
          },
          trx,
        );
      });
      return 'withdrawn';
    } catch (error) {
      if (isUniqueViolation(error)) {
        return 'already_withdrawn';
      }
      // The matter closed, or the person left its team, a moment earlier.
      if (isCheckViolation(error)) {
        return 'changed';
      }
      throw error;
    }
  }

  /** Shares or unshares a document, if the caller is on its matter's team. */
  async changeSharing(documentId: string, shared: boolean, by: DocumentActor): Promise<ChangeSharingResult> {
    const document = await this.documents.findForChange(documentId, by.accountId);
    if (!document) {
      return 'not_found';
    }
    if (document.withdrawn) {
      return 'withdrawn';
    }
    if (document.sharedWithClient === shared) {
      return 'unchanged';
    }
    try {
      const changed = await this.documents.transaction(async (trx) => {
        const recorded = await this.documents.changeSharing(documentId, shared, by.accountId, trx);
        if (recorded) {
          await this.audit.record(
            {
              actor: by.actor,
              action: shared ? 'document.shared' : 'document.unshared',
              outcome: 'success',
              resource: { type: 'document', id: documentId },
              metadata: { matterId: document.matterId },
              ...by.context,
            },
            trx,
          );
        }
        return recorded;
      });
      return changed ? 'changed' : 'unchanged';
    } catch (error) {
      if (isCheckViolation(error)) {
        return 'changed_meanwhile';
      }
      throw error;
    }
  }

  /**
   * Receives an upload for a matter and, if it is accepted, records it with
   * `record` in one transaction. A refused file, or one the database will not
   * take after all, leaves nothing stored.
   */
  private async accept<T>(
    target: { matterId: string; matterReference: string },
    upload: { fileName: string; file: Readable },
    by: DocumentActor,
    record: (file: AcceptedFile, trx: Kysely<Database>) => Promise<T>,
  ): Promise<{ outcome: 'accepted'; value: T; file: AcceptedFile } | { outcome: 'refused'; reason: UploadRefusal } | { outcome: 'not_open' }> {
    const fileName = fileNameSchema.safeParse(upload.fileName);
    if (!fileName.success) {
      discardUpload(upload.file);
      return this.refuse(target.matterId, by, 'file_name');
    }
    // Checked before the file is read, so nobody over the allowance sends 50 MB to be refused.
    if (!(await this.withinAllowance(by.accountId, 0))) {
      discardUpload(upload.file);
      return this.refuseOverAllowance(target.matterId, by);
    }

    const received = await this.receive(fileName.data, upload.file);
    if ('refusal' in received) {
      if (received.refusal === 'malware' && received.signature) {
        await this.notices.malwareRefused({ matterReference: target.matterReference, uploadedBy: by.accountId, signature: received.signature });
      }
      return this.refuse(target.matterId, by, received.refusal, received.signature);
    }

    const file = { fileName: fileName.data, ...received };
    try {
      const value = await this.documents.transaction(async (trx) => {
        // Again under a per-person lock, with this file counted, so uploads at once cannot all slip under it.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`app.document_uploads:${by.accountId}`}, 0))`.execute(trx);
        if (!(await this.withinAllowance(by.accountId, file.inspected.sizeBytes, trx))) {
          throw new OverAllowanceError();
        }
        return record(file, trx);
      });
      return { outcome: 'accepted', value, file };
    } catch (error) {
      await this.vault.discard(received.stored.storageKey);
      if (error instanceof OverAllowanceError) {
        return this.refuseOverAllowance(target.matterId, by);
      }
      // The matter was closed, the person removed from its team, or the document withdrawn, while the file arrived.
      if (isCheckViolation(error)) {
        return { outcome: 'not_open' };
      }
      throw error;
    }
  }

  /**
   * Whether `accountId` may record one more file of `sizeBytes` this hour
   * (review D4), counted from the audit records of what they added.
   */
  private async withinAllowance(accountId: string, sizeBytes: number, trx?: Kysely<Database>): Promise<boolean> {
    const { count, total } = await this.audit.recentTotals(
      { actorId: accountId, actions: ['document.added', 'document.version_added'], seconds: UPLOAD_WINDOW_SECONDS, field: 'sizeBytes' },
      trx,
    );
    return count + 1 <= UPLOADS_PER_HOUR && total + sizeBytes <= UPLOAD_BYTES_PER_HOUR;
  }

  /**
   * Refuses an upload over the allowance. The first refusal in an hour is
   * also recorded as `document.upload_limited` and reported to the
   * administrators; later ones are only refused.
   */
  private async refuseOverAllowance(matterId: string, by: DocumentActor): Promise<{ outcome: 'refused'; reason: UploadRefusal }> {
    const alreadyLimited = await this.audit.countRecent({ actorId: by.accountId, action: 'document.upload_limited', seconds: UPLOAD_WINDOW_SECONDS });
    if (alreadyLimited === 0) {
      await this.audit.record({
        actor: by.actor,
        action: 'document.upload_limited',
        outcome: 'denied',
        metadata: { files: UPLOADS_PER_HOUR, bytes: UPLOAD_BYTES_PER_HOUR },
        ...by.context,
      });
      await this.notices.uploadLimitReached({ accountId: by.accountId, files: UPLOADS_PER_HOUR, gigabytes: UPLOAD_BYTES_PER_HOUR / 1024 ** 3 });
    }
    return this.refuse(matterId, by, 'over_allowance');
  }

  private recordVersion(
    action: 'document.added' | 'document.version_added',
    documentId: string,
    matterId: string,
    version: number,
    inspected: InspectedFile,
    by: DocumentActor,
    trx: Kysely<Database>,
  ): Promise<void> {
    return this.audit.record(
      {
        actor: by.actor,
        action,
        outcome: 'success',
        resource: { type: 'document', id: documentId },
        metadata: { matterId, version, mediaType: inspected.mediaType, sizeBytes: inspected.sizeBytes },
        ...by.context,
      },
      trx,
    );
  }

  /** One page of the matter's documents; undefined if `viewerId` is not on its team. */
  async list(matterId: string, viewerId: string, before?: string): Promise<{ documents: DocumentSummary[]; next: string | null } | undefined> {
    const documents = await this.documents.listForMatter(matterId, visibleTo(viewerId), { before, limit: DOCUMENTS_PAGE_SIZE });
    if (!documents) {
      return undefined;
    }
    return { documents, next: documents.length === DOCUMENTS_PAGE_SIZE ? (documents.at(-1)?.id ?? null) : null };
  }

  /**
   * The matter's documents, read through a compliance access to it.
   * shortcut: newest DOCUMENTS_PAGE_SIZE only, add paging if a reviewed matter ever holds more.
   */
  async listThroughComplianceAccess(matterId: string, accessId: string): Promise<DocumentSummary[]> {
    return (await this.documents.listForMatter(matterId, reachedByComplianceAccess(accessId), { limit: DOCUMENTS_PAGE_SIZE })) ?? [];
  }

  find(documentId: string, viewerId: string): Promise<DocumentDetails | undefined> {
    return this.documents.findVisible(documentId, viewerId);
  }

  /**
   * One version, decrypted as it streams, for the matter's team, or through
   * the compliance access `accessId` recorded for that version. The download
   * is recorded before any of it is sent. An error part-way through the stream
   * means the stored file was changed: the caller must abandon the response.
   */
  async download(documentId: string, number: number, by: DocumentActor, accessId?: string): Promise<DownloadResult> {
    const version = await this.documents.findVersionToDownload(documentId, number, accessId ? { accessId } : { viewerId: by.accountId });
    if (!version) {
      return { outcome: 'not_found' };
    }
    if (version.withdrawn) {
      return { outcome: 'withdrawn' };
    }
    const file = await this.vault.open({
      storageKey: version.storage_key,
      sealedKey: { keyVersion: version.key_version, nonce: version.key_nonce, ciphertext: version.wrapped_key, authTag: version.key_tag },
    });
    await this.audit.record({
      actor: by.actor,
      action: 'document.downloaded',
      outcome: 'success',
      resource: { type: 'document', id: documentId },
      metadata: { matterId: version.matter_id, version: number, ...(accessId && { accessId }) },
      ...by.context,
    });
    return { outcome: 'ready', file, fileName: version.file_name, mediaType: version.media_type, sizeBytes: version.size_bytes };
  }

  /**
   * Inspects, scans and stores the file in one pass. If any of the three
   * stops, the others are stopped too, so a scanner that cannot be reached
   * cannot leave the upload waiting. The first to stop explains the outcome;
   * the others then fail only because they were stopped. Bytes stored for a
   * file that is then refused are removed.
   */
  private async receive(fileName: string, file: Readable): Promise<Received> {
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
    // Their errors only repeat the first one, already recorded; the scanner and vault see them as they read.
    toScanner.on('error', () => undefined);
    toVault.on('error', () => undefined);
    if (file.destroyed) {
      // Stopped while the matter was being checked, before any of it was read.
      stop('file')(file.errored ?? new Error('The upload was interrupted'));
    }
    file.pipe(inspection);
    inspection.pipe(toScanner);
    inspection.pipe(toVault);

    const scanning = this.scanner.scan(toScanner);
    const storing = this.vault.store(toVault);
    scanning.catch(stop('scanner'));
    storing.catch(stop('storage'));
    const [scan, store] = await Promise.allSettled([scanning, storing]);

    const refusal = refusalFor(first, scan);
    if (refusal ?? first) {
      if (store.status === 'fulfilled') {
        await this.vault.discard(store.value.storageKey);
      }
    }
    if (refusal) {
      return refusal;
    }
    if (first) {
      // Storage failed, or the inspection failed for a reason other than the file: not the uploader's doing.
      throw first.error;
    }
    if (scan.status === 'rejected' || store.status === 'rejected') {
      throw new Error('Upload ended without an answer');
    }
    return { inspected: inspection.result(), stored: store.value };
  }

  private async refuse(matterId: string, by: DocumentActor, reason: UploadRefusal, signature?: string): Promise<{ outcome: 'refused'; reason: UploadRefusal }> {
    await this.audit.record({
      actor: by.actor,
      action: 'document.refused',
      outcome: 'failure',
      resource: { type: 'matter', id: matterId },
      metadata: { reason, ...(signature ? { signature } : {}) },
      ...by.context,
    });
    return { outcome: 'refused', reason };
  }
}

/** Why an upload is refused, from what stopped it first; undefined when the file is not to blame. */
function refusalFor(
  first: { origin: 'file' | 'inspection' | 'scanner' | 'storage'; error: unknown } | undefined,
  scan: PromiseSettledResult<ScanResult>,
): { refusal: UploadRefusal; signature?: string } | undefined {
  if (first?.origin === 'inspection' && first.error instanceof FileRefusedError) {
    return { refusal: first.error.reason };
  }
  if (first?.origin === 'file') {
    return { refusal: first.error instanceof UploadFormError ? 'form' : 'interrupted' };
  }
  if (first?.origin === 'scanner') {
    return { refusal: 'scanner_unavailable' };
  }
  if (!first && scan.status === 'fulfilled' && !scan.value.clean) {
    return { refusal: isLimitsAlert(scan.value.signature) ? 'unscannable' : 'malware', signature: scan.value.signature };
  }
  return undefined;
}

const versionOf = (file: AcceptedFile) => ({ fileName: file.fileName, mediaType: file.inspected.mediaType, sizeBytes: file.inspected.sizeBytes });

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23514';
}
