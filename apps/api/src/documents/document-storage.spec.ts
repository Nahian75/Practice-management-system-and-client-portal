import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/database.js';
import { eicarTestFile } from '../../test/eicar.js';
import { DocumentVault } from './document-vault.js';
import { FileCipherError } from './file-cipher.js';
import { ObjectNotFoundError, ObjectStorage } from './object-storage.js';
import { ScannerUnavailableError, VirusScanner } from './virus-scanner.js';

// Against the SeaweedFS and ClamAV containers from docker compose (docs/documents.md).
describe('document storage', () => {
  let storage: ObjectStorage;
  let vault: DocumentVault;

  beforeAll(() => {
    storage = new ObjectStorage(testEnv());
    vault = new DocumentVault(storage, testEnv());
  });

  afterAll(() => {
    storage.onApplicationShutdown();
  });

  describe('the bucket', () => {
    it('stores and returns bytes under a key', async () => {
      const key = randomUUID();
      const bytes = randomBytes(1000);

      await storage.put(key, Readable.from([bytes]));

      expect(await buffer(await storage.get(key))).toEqual(bytes);
    });

    it('says so for a key with nothing stored, and after removal', async () => {
      const key = randomUUID();
      await storage.put(key, Readable.from([randomBytes(10)]));
      await storage.remove(key);

      await expect(storage.get(key)).rejects.toThrow(ObjectNotFoundError);
      await expect(storage.get(randomUUID())).rejects.toThrow(ObjectNotFoundError);
    });

    it('accepts only random ids as keys, never a name or a path', async () => {
      await expect(storage.get('lease.pdf')).rejects.toThrow(/UUID/);
      await expect(storage.get('../pms-documents/x')).rejects.toThrow(/UUID/);
    });

    it('refuses the wrong credentials', async () => {
      const intruder = new ObjectStorage(testEnv({ DOCUMENTS_S3_SECRET_KEY: 'not-the-secret-key-at-all' }));

      await expect(intruder.put(randomUUID(), Readable.from([randomBytes(10)]))).rejects.toThrow();
      intruder.onApplicationShutdown();
    });
  });

  describe('the vault', () => {
    it('returns the file it stored, and stores only encrypted bytes', async () => {
      const plaintext = Buffer.from('Completion statement for 12 High Street. '.repeat(2000));

      const stored = await vault.store(Readable.from([plaintext]));

      expect(await buffer(await vault.open(stored))).toEqual(plaintext);
      const raw = await buffer(await storage.get(stored.storageKey));
      expect(raw.includes(Buffer.from('High Street'))).toBe(false);
      expect(raw.subarray(0, 4).toString('ascii')).toBe('PMSD');
    });

    it('gives each file its own storage key and key', async () => {
      const first = await vault.store(Readable.from([Buffer.from('same')]));
      const second = await vault.store(Readable.from([Buffer.from('same')]));

      expect(first.storageKey).not.toBe(second.storageKey);
      expect(first.sealedKey.ciphertext.equals(second.sealedKey.ciphertext)).toBe(false);
    });

    it("will not open a file with another file's key", async () => {
      const first = await vault.store(Readable.from([randomBytes(100)]));
      const second = await vault.store(Readable.from([randomBytes(100)]));

      await expect(vault.open({ storageKey: first.storageKey, sealedKey: second.sealedKey })).rejects.toThrow(/integrity/);
    });

    it('will not open stored bytes that were changed', async () => {
      const stored = await vault.store(Readable.from([randomBytes(5000)]));
      const raw = await buffer(await storage.get(stored.storageKey));
      raw[raw.length - 30] = (raw[raw.length - 30] ?? 0) ^ 0x01;
      await storage.put(stored.storageKey, Readable.from([raw]));

      await expect(buffer(await vault.open(stored))).rejects.toThrow(FileCipherError);
    });

    it('cannot open anything with another master key', async () => {
      const stored = await vault.store(Readable.from([randomBytes(100)]));
      const otherVault = new DocumentVault(storage, testEnv({ DOCUMENT_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));

      await expect(otherVault.open(stored)).rejects.toThrow(/integrity/);
    });

    it('fails, rather than waiting, when the file being stored breaks off', async () => {
      const broken = new Readable({ read() {} });
      const storing = vault.store(broken);
      broken.push(randomBytes(100));
      broken.destroy(new Error('Upload interrupted'));

      await expect(storing).rejects.toThrow();
    });
  });

  describe('the scanner', () => {
    const scanner = () => new VirusScanner(testEnv());

    it('passes a clean file', async () => {
      expect(await scanner().scan(Readable.from([Buffer.from('An ordinary letter to the client.')]))).toEqual({ clean: true });
    });

    it('finds the EICAR test file, and names it', async () => {
      expect(await scanner().scan(Readable.from([eicarTestFile()]))).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    });

    it('finds it when it arrives in pieces', async () => {
      const file = eicarTestFile();

      const result = await scanner().scan(Readable.from([file.subarray(0, 10), file.subarray(10, 40), file.subarray(40)]));

      expect(result.clean).toBe(false);
    });

    it('scans a large file', async () => {
      const pieces = Array.from({ length: 80 }, () => randomBytes(64 * 1024));

      expect(await scanner().scan(Readable.from(pieces))).toEqual({ clean: true });
    });

    it('fails closed when the scanner cannot be reached', async () => {
      const unreachable = new VirusScanner(testEnv({ CLAMAV_PORT: 3109 }));

      await expect(unreachable.scan(Readable.from([Buffer.from('anything')]))).rejects.toThrow(ScannerUnavailableError);
    });
  });
});
