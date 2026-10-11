import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { ObjectStorage } from '../documents/object-storage.js';
import { SuspicionEvidenceVault } from './suspicion-evidence-vault.js';

async function bytes(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('SuspicionEvidenceVault', () => {
  it('uses the restricted namespace and streams an intact round trip', async () => {
    const storage = new ObjectStorage(testEnv()), vault = new SuspicionEvidenceVault(storage, testEnv());
    const plaintext = Buffer.from('restricted internal disclosure attachment');
    const stored = await vault.store(Readable.from([plaintext]));
    try {
      expect(stored.storageKey).toMatch(/^compliance\/restricted\/[0-9a-f-]{36}$/);
      expect(await bytes(await vault.open(stored))).toEqual(plaintext);
    } finally { await vault.discard(stored.storageKey); storage.onApplicationShutdown(); }
  });

  it('cannot unwrap the file key with another suspicion key', async () => {
    const storage = new ObjectStorage(testEnv()), vault = new SuspicionEvidenceVault(storage, testEnv());
    const stored = await vault.store(Readable.from([Buffer.from('restricted')]));
    try {
      const other = new SuspicionEvidenceVault(storage, testEnv({ SUSPICION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
      await expect(other.open(stored)).rejects.toThrow(/integrity check/);
    } finally { await vault.discard(stored.storageKey); storage.onApplicationShutdown(); }
  });
});
