import { PassThrough, type Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { FileInspection, FileRefusedError, type RefusalReason } from '../documents/file-inspection.js';
import { UploadFormError } from '../documents/upload-request.js';
import { isLimitsAlert, VirusScanner } from '../documents/virus-scanner.js';
import { AmlEvidenceVault, type StoredAmlEvidence } from './aml-evidence-vault.js';

export type AmlEvidenceRefusal = RefusalReason | 'malware' | 'scanner_unavailable' | 'unscannable' | 'form' | 'interrupted';
export interface ReceivedAmlEvidence {
  inspected: ReturnType<FileInspection['result']>;
  stored: StoredAmlEvidence;
}

/** Shared streaming inspection/scanning/storage boundary for staff and requested portal AML evidence. */
@Injectable()
export class AmlEvidenceIntake {
  constructor(private readonly scanner: VirusScanner, private readonly vault: AmlEvidenceVault) {}

  async receive(fileName: string, file: Readable): Promise<ReceivedAmlEvidence | { reason: AmlEvidenceRefusal }> {
    const inspection = new FileInspection(fileName);
    const toScanner = new PassThrough(); const toVault = new PassThrough();
    let first: { origin: 'file' | 'inspection' | 'scanner' | 'storage'; error: unknown } | undefined;
    const stop = (origin: NonNullable<typeof first>['origin']) => (error: unknown) => {
      first ??= { origin, error };
      const reason = error instanceof Error ? error : new Error('Upload stopped');
      inspection.destroy(reason); toScanner.destroy(reason); toVault.destroy(reason);
    };
    file.on('error', stop('file')); inspection.on('error', stop('inspection'));
    toScanner.on('error', () => undefined); toVault.on('error', () => undefined);
    if (file.destroyed) stop('file')(file.errored ?? new Error('The upload was interrupted'));
    file.pipe(inspection); inspection.pipe(toScanner); inspection.pipe(toVault);
    const scanning = this.scanner.scan(toScanner); const storing = this.vault.store(toVault);
    scanning.catch(stop('scanner')); storing.catch(stop('storage'));
    const [scan, store] = await Promise.allSettled([scanning, storing]);
    let reason: AmlEvidenceRefusal | undefined;
    if (first?.origin === 'inspection' && first.error instanceof FileRefusedError) reason = first.error.reason;
    else if (first?.origin === 'scanner') reason = 'scanner_unavailable';
    else if (first?.origin === 'file') reason = first.error instanceof UploadFormError ? 'form' : 'interrupted';
    else if (!first && scan.status === 'fulfilled' && !scan.value.clean) {
      reason = isLimitsAlert(scan.value.signature) ? 'unscannable' : 'malware';
    }
    if (reason || first) {
      if (store.status === 'fulfilled') await this.vault.discard(store.value.storageKey);
      if (reason) return { reason };
      throw first!.error;
    }
    if (scan.status === 'rejected' || store.status === 'rejected') throw new Error('Evidence upload ended without an answer');
    return { inspected: inspection.result(), stored: store.value };
  }
}
