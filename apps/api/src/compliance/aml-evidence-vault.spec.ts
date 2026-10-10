import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ObjectStorage } from '../documents/object-storage.js';
import { AmlEvidenceVault } from './aml-evidence-vault.js';

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('AmlEvidenceVault', () => {
  it('uses the compliance namespace and streams an intact round trip', async () => {
    const storage = new ObjectStorage(testEnv());
    const vault = new AmlEvidenceVault(storage, testEnv());
    const plaintext = Buffer.from('protected CDD evidence');
    const stored = await vault.store(Readable.from([plaintext]));
    try {
      expect(stored.storageKey).toMatch(/^compliance\/[0-9a-f-]{36}$/);
      expect(await bytes(await vault.open(stored))).toEqual(plaintext);
    } finally {
      await vault.discard(stored.storageKey);
      storage.onApplicationShutdown();
    }
  });

  it('cannot unwrap a file key under another AML master key', async () => {
    const storage = new ObjectStorage(testEnv());
    const vault = new AmlEvidenceVault(storage, testEnv());
    const stored = await vault.store(Readable.from([Buffer.from('protected')]));
    try {
      const other = new AmlEvidenceVault(storage, testEnv({ AML_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
      await expect(other.open(stored)).rejects.toThrow(/integrity check/);
    } finally {
      await vault.discard(stored.storageKey);
      storage.onApplicationShutdown();
    }
  });
});
