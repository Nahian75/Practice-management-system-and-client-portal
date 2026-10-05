import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SecurityNoticesService } from '../auth/notices/security-notices.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import { text } from '../common/validation/safe-text.js';
import type { DocumentCategory, DocumentMediaType } from '../database/schema.js';
import { DocumentVault, type StoredFile } from './document-vault.js';
import { DocumentsRepository } from './documents.repository.js';
import { FileInspection, FileRefusedError, type InspectedFile, type RefusalReason } from './file-inspection.js';
import { discardUpload, UploadFormError } from './upload-request.js';
import { VirusScanner, type ScanResult } from './virus-scanner.js';

/** The signed-in staff member acting, and the request it came from. */
export interface DocumentActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type UploadRefusal = RefusalReason | 'malware' | 'scanner_unavailable' | 'file_name' | 'form' | 'interrupted';

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
    const fileName = fileNameSchema.safeParse(upload.fileName);
    if (!fileName.success) {
      discardUpload(upload.file);
      return this.refuse(matterId, by, 'file_name');
    }

    const received = await this.receive(fileName.data, upload.file);
    if ('refusal' in received) {
      if (received.refusal === 'malware' && received.signature) {
        await this.notices.malwareRefused({ matterReference: matter.reference, uploadedBy: by.accountId, signature: received.signature });
      }
      return this.refuse(matterId, by, received.refusal, received.signature);
    }

    const { inspected, stored } = received;
    try {
      const document = await this.documents.transaction(async (trx) => {
        const added = await this.documents.insert(
          { matterId, title: details.title, category: details.category, createdBy: by.accountId },
          { fileName: fileName.data, ...inspected, storageKey: stored.storageKey, sealedKey: stored.sealedKey },
          trx,
        );
        await this.audit.record(
          {
            actor: by.actor,
            action: 'document.added',
            outcome: 'success',
            resource: { type: 'document', id: added.id },
            metadata: { matterId, version: added.version.number, mediaType: inspected.mediaType, sizeBytes: inspected.sizeBytes },
            ...by.context,
          },
          trx,
        );
        return added;
      });
      return {
        outcome: 'added',
        document: {
          id: document.id,
          title: document.title,
          category: document.category,
          createdAt: document.created_at,
          version: {
            number: document.version.number,
            fileName: fileName.data,
            mediaType: inspected.mediaType,
            sizeBytes: inspected.sizeBytes,
            uploadedAt: document.version.uploaded_at,
          },
        },
      };
    } catch (error) {
      await this.vault.discard(stored.storageKey);
      // The matter was closed, or the person removed from its team, while the file arrived.
      if (isCheckViolation(error)) {
        return { outcome: 'not_open' };
      }
      throw error;
    }
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

  private async refuse(matterId: string, by: DocumentActor, reason: UploadRefusal, signature?: string): Promise<AddResult> {
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
    return { refusal: 'malware', signature: scan.value.signature };
  }
  return undefined;
}

function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23514';
}
