import { randomUUID } from 'node:crypto';
import type { Readable, Transform } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DecryptingStream, EncryptingStream, newFileKey } from './file-cipher.js';
import { ObjectStorage } from './object-storage.js';

const MASTER_KEY_VERSION = 1;

export interface StoredFile {
  storageKey: string;
  /** The file's own key, sealed with the master key and bound to `storageKey`. */
  sealedKey: SealedSecret;
}

/**
 * Keeps files encrypted at rest. Each file gets its own key, which is sealed
 * with the master key and kept in the database, never in storage: a copy of
 * the storage alone, or of the database alone, opens nothing.
 */
@Injectable()
export class DocumentVault {
  private readonly keys: SecretBox;

  constructor(
    private readonly storage: ObjectStorage,
    @Inject(ENV) env: Env,
  ) {
    this.keys = new SecretBox(Buffer.from(env.DOCUMENT_ENCRYPTION_KEY, 'base64'), MASTER_KEY_VERSION);
  }

  /** Encrypts `plaintext` as it streams into storage, under a new key and a new random storage key. */
  async store(plaintext: Readable): Promise<StoredFile> {
    const storageKey = randomUUID();
    const fileKey = newFileKey();
    const encrypting = piped(plaintext, new EncryptingStream(fileKey));
    // The storage library waits for data it may never get if the file fails before it starts
    // reading: the first failure ends the wait and cancels the upload.
    const abort = new AbortController();
    const failed = new Promise<never>((_resolve, reject) => {
      const fail = (error: unknown) => {
        abort.abort();
        reject(error instanceof Error ? error : new Error('The file could not be stored'));
      };
      if (encrypting.errored) {
        fail(encrypting.errored);
      }
      encrypting.once('error', fail);
    });
    const storing = this.storage.put(storageKey, encrypting, abort);
    failed.catch(() => undefined);
    storing.catch(() => undefined);
    await Promise.race([storing, failed]);
    return { storageKey, sealedKey: this.keys.seal(fileKey, contextFor(storageKey)) };
  }

  /**
   * The file, decrypted as it streams. An error part-way means the stored
   * bytes were changed or cut short: whatever was already read must be discarded.
   */
  async open(file: StoredFile): Promise<Readable> {
    const fileKey = this.keys.open(file.sealedKey, contextFor(file.storageKey));
    return piped(await this.storage.get(file.storageKey), new DecryptingStream(fileKey));
  }

  /** Removes stored bytes that will never be recorded, such as a refused upload's. */
  discard(storageKey: string): Promise<void> {
    return this.storage.remove(storageKey);
  }
}

const contextFor = (storageKey: string) => `document-key:${storageKey}`;

/** `source` piped into `transform`, with an error in `source` passed on rather than leaving `transform` waiting. */
function piped<T extends Transform>(source: Readable, transform: T): T {
  source.once('error', (error) => transform.destroy(error));
  return source.pipe(transform);
}
