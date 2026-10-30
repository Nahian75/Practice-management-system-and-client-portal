import { secretBoxFor } from '../common/crypto/key-ring.js';
import { randomUUID } from 'node:crypto';
import type { Readable, Transform } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DecryptingStream, EncryptingStream, newFileKey } from '../documents/file-cipher.js';
import { ObjectStorage } from '../documents/object-storage.js';

export interface StoredHrFile { storageKey: string; sealedKey: SealedSecret }

/** HR files are encrypted under the independent HR key and `hr/` namespace. */
@Injectable()
export class HrFileVault {
  private readonly keys: SecretBox;

  constructor(private readonly storage: ObjectStorage, @Inject(ENV) env: Env) {
    this.keys = secretBoxFor(env, 'HR');
  }

  async store(plaintext: Readable): Promise<StoredHrFile> {
    const storageKey = `hr/${randomUUID()}`;
    const fileKey = newFileKey();
    const encrypting = piped(plaintext, new EncryptingStream(fileKey));
    const abort = new AbortController();
    const failed = new Promise<never>((_resolve, reject) => {
      const fail = (error: unknown) => {
        abort.abort();
        reject(error instanceof Error ? error : new Error('The HR file could not be stored'));
      };
      if (encrypting.errored) fail(encrypting.errored);
      encrypting.once('error', fail);
    });
    const storing = this.storage.put(storageKey, encrypting, abort);
    failed.catch(() => undefined);
    storing.catch(() => undefined);
    await Promise.race([storing, failed]);
    return { storageKey, sealedKey: this.keys.seal(fileKey, contextFor(storageKey)) };
  }

  async open(file: StoredHrFile): Promise<Readable> {
    const fileKey = this.keys.open(file.sealedKey, contextFor(file.storageKey));
    return piped(await this.storage.get(file.storageKey), new DecryptingStream(fileKey));
  }

  discard(storageKey: string): Promise<void> { return this.storage.remove(storageKey); }
}

const contextFor = (storageKey: string) => `hr-file-key:${storageKey}`;
function piped<T extends Transform>(source: Readable, transform: T): T {
  source.once('error', (error) => transform.destroy(error));
  return source.pipe(transform);
}
