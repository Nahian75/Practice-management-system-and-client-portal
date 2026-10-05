import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { DecryptingStream, DEFAULT_CHUNK_BYTES, EncryptingStream, FileCipherError, newFileKey } from './file-cipher.js';

const CHUNK = 64;
const HEADER = 16;
const SEALED_CHUNK = CHUNK + 16;

/** Feeds `data` in pieces of random sizes, as a network upload would arrive. */
function inPieces(data: Buffer): Readable {
  const pieces: Buffer[] = [];
  for (let at = 0; at < data.length; ) {
    const size = 1 + Math.floor(Math.random() * 100);
    pieces.push(data.subarray(at, at + size));
    at += size;
  }
  return Readable.from(pieces);
}

async function run(stream: EncryptingStream | DecryptingStream, data: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(inPieces(data), stream, async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      chunks.push(chunk);
    }
  });
  return Buffer.concat(chunks);
}

const encrypt = (key: Buffer, data: Buffer, chunkBytes = CHUNK) => run(new EncryptingStream(key, chunkBytes), data);
const decrypt = (key: Buffer, data: Buffer) => run(new DecryptingStream(key), data);

describe('file encryption', () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 5 * CHUNK + 17])('round-trips a %i-byte file', async (size) => {
    const key = newFileKey();
    const plaintext = randomBytes(size);

    const sealed = await encrypt(key, plaintext);

    expect(sealed.length).toBe(HEADER + Math.max(1, Math.ceil(size / CHUNK)) * 16 + size);
    expect(await decrypt(key, sealed)).toEqual(plaintext);
  });

  it('round-trips a file larger than one default chunk', async () => {
    const key = newFileKey();
    const plaintext = randomBytes(3 * DEFAULT_CHUNK_BYTES + 5);

    const sealed = await run(new EncryptingStream(key), plaintext);

    expect(await decrypt(key, sealed)).toEqual(plaintext);
  });

  it('gives different bytes for the same file each time, and none of the file shows', async () => {
    const plaintext = Buffer.from('Contract between Jane Doe and Acme Trading Ltd. '.repeat(10));
    const key = newFileKey();

    const first = await encrypt(key, plaintext);
    const second = await encrypt(key, plaintext);

    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from('Jane Doe'))).toBe(false);
  });

  it('passes data on before the whole file has arrived', async () => {
    const stream = new EncryptingStream(newFileKey(), CHUNK);
    const received: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => received.push(chunk));

    stream.write(randomBytes(3 * CHUNK));
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(received).length).toBeGreaterThan(HEADER);
    stream.end();
  });

  describe('refuses a file that has been changed', () => {
    const cases: [string, (sealed: Buffer) => Buffer][] = [
      ['a byte of the header', (sealed) => flip(sealed, 8)],
      ['a byte of the first chunk', (sealed) => flip(sealed, HEADER + 3)],
      ['a byte of a tag', (sealed) => flip(sealed, HEADER + SEALED_CHUNK - 1)],
      ['a byte of the last chunk', (sealed) => flip(sealed, sealed.length - 20)],
      ['the last chunk removed', (sealed) => sealed.subarray(0, HEADER + 2 * SEALED_CHUNK)],
      ['the end cut off mid-chunk', (sealed) => sealed.subarray(0, sealed.length - 5)],
      ['two chunks swapped', (sealed) =>
        Buffer.concat([
          sealed.subarray(0, HEADER),
          sealed.subarray(HEADER + SEALED_CHUNK, HEADER + 2 * SEALED_CHUNK),
          sealed.subarray(HEADER, HEADER + SEALED_CHUNK),
          sealed.subarray(HEADER + 2 * SEALED_CHUNK),
        ])],
      ['a chunk repeated', (sealed) =>
        Buffer.concat([sealed.subarray(0, HEADER + SEALED_CHUNK), sealed.subarray(HEADER, HEADER + SEALED_CHUNK), sealed.subarray(HEADER + SEALED_CHUNK)])],
      ['bytes added at the end', (sealed) => Buffer.concat([sealed, randomBytes(SEALED_CHUNK)])],
      ['only the header left', (sealed) => sealed.subarray(0, HEADER)],
      ['nothing left', () => Buffer.alloc(0)],
    ];

    it.each(cases)('%s', async (_case, change) => {
      const key = newFileKey();
      const sealed = await encrypt(key, randomBytes(3 * CHUNK + 10));

      await expect(decrypt(key, change(sealed))).rejects.toThrow(FileCipherError);
    });

    it('chunks moved in from another file', async () => {
      const key = newFileKey();
      const first = await encrypt(key, randomBytes(3 * CHUNK));
      const second = await encrypt(key, randomBytes(3 * CHUNK));

      const mixed = Buffer.concat([first.subarray(0, HEADER + SEALED_CHUNK), second.subarray(HEADER + SEALED_CHUNK)]);

      await expect(decrypt(key, mixed)).rejects.toThrow(FileCipherError);
    });
  });

  it('refuses the wrong key', async () => {
    const sealed = await encrypt(newFileKey(), randomBytes(100));

    await expect(decrypt(newFileKey(), sealed)).rejects.toThrow(FileCipherError);
  });

  it('refuses a file of another format or version', async () => {
    const key = newFileKey();
    const sealed = await encrypt(key, randomBytes(100));
    const otherVersion = Buffer.from(sealed);
    otherVersion[4] = 2;

    await expect(decrypt(key, Buffer.concat([Buffer.from('%PDF'), sealed.subarray(4)]))).rejects.toThrow(/known version/);
    await expect(decrypt(key, otherVersion)).rejects.toThrow(/known version/);
  });

  it('refuses keys and chunk sizes that are not allowed', () => {
    expect(() => new EncryptingStream(randomBytes(16))).toThrow(FileCipherError);
    expect(() => new DecryptingStream(randomBytes(31))).toThrow(FileCipherError);
    expect(() => new EncryptingStream(newFileKey(), 8)).toThrow(FileCipherError);
    expect(() => new EncryptingStream(newFileKey(), 2 * 1024 * 1024)).toThrow(FileCipherError);
  });
});

function flip(data: Buffer, at: number): Buffer {
  const changed = Buffer.from(data);
  changed[at] = (changed[at] ?? 0) ^ 0x01;
  return changed;
}
