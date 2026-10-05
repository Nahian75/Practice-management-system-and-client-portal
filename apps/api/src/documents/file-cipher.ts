import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

const ALGORITHM = 'aes-256-gcm';
const MAGIC = Buffer.from('PMSD', 'ascii');
const FORMAT_VERSION = 1;
const NONCE_PREFIX_BYTES = 7;
const HEADER_BYTES = MAGIC.length + 1 + 4 + NONCE_PREFIX_BYTES;
const TAG_BYTES = 16;
const MAX_CHUNKS = 2 ** 32;

export const FILE_KEY_BYTES = 32;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MIN_CHUNK_BYTES = 16;
const MAX_CHUNK_BYTES = 1024 * 1024;

export class FileCipherError extends Error {
  override readonly name = 'FileCipherError';
}

/*
 * Encrypted file format, version 1:
 *
 *   header  "PMSD" | version (1 byte) | chunk size (uint32 BE) | nonce prefix (7 random bytes)
 *   chunks  AES-256-GCM ciphertext of up to `chunk size` bytes, then its 16-byte tag
 *
 * Each chunk's nonce is the prefix, the chunk's number (uint32 BE) and a flag
 * set only on the last chunk; the header is authenticated with every chunk.
 * So no chunk can be changed, reordered, dropped, repeated or moved to another
 * file, and a file cut short fails: its last chunk is not marked as last.
 * This is the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár, 2015).
 * An empty file is one empty last chunk.
 */

function nonceFor(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index >= MAX_CHUNKS) {
    throw new FileCipherError('File too large to encrypt');
  }
  const nonce = Buffer.alloc(NONCE_PREFIX_BYTES + 5);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  nonce[NONCE_PREFIX_BYTES + 4] = last ? 1 : 0;
  return nonce;
}

function checkKey(key: Buffer): void {
  if (key.length !== FILE_KEY_BYTES) {
    throw new FileCipherError(`A file key is ${FILE_KEY_BYTES} bytes`);
  }
}

function checkChunkBytes(chunkBytes: number): void {
  if (!Number.isInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES) {
    throw new FileCipherError(`Chunk size must be ${MIN_CHUNK_BYTES} to ${MAX_CHUNK_BYTES} bytes`);
  }
}

/**
 * Encrypts what is written to it, chunk by chunk, so a large file is never
 * held whole in memory. A new random key per file is the caller's job
 * (`newFileKey`); a key must never encrypt two files.
 */
export class EncryptingStream extends Transform {
  private readonly header: Buffer;
  private readonly prefix = randomBytes(NONCE_PREFIX_BYTES);
  private pending = Buffer.alloc(0);
  private index = 0;
  private started = false;

  constructor(
    private readonly key: Buffer,
    private readonly chunkBytes = DEFAULT_CHUNK_BYTES,
  ) {
    super();
    checkKey(key);
    checkChunkBytes(chunkBytes);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(chunkBytes);
    this.header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), size, this.prefix]);
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.start();
      this.pending = Buffer.concat([this.pending, data]);
      // A full chunk is sealed only once more data follows it: the last chunk must be marked as last.
      while (this.pending.length > this.chunkBytes) {
        this.push(this.seal(this.pending.subarray(0, this.chunkBytes), false));
        this.pending = this.pending.subarray(this.chunkBytes);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.start();
      this.push(this.seal(this.pending, true));
      this.pending = Buffer.alloc(0);
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  private start(): void {
    if (!this.started) {
      this.started = true;
      this.push(this.header);
    }
  }

  private seal(plaintext: Buffer, last: boolean): Buffer {
    const cipher = createCipheriv(ALGORITHM, this.key, nonceFor(this.prefix, this.index++, last)).setAAD(this.header);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }
}

/**
 * Decrypts a file written by `EncryptingStream`. Each chunk is checked before
 * any of it is passed on, but a file cut short is only found at its end: a
 * reader must treat an error at any point as "this file cannot be trusted"
 * and discard what it already received.
 */
export class DecryptingStream extends Transform {
  private header: Buffer | undefined;
  private prefix = Buffer.alloc(0);
  private chunkBytes = 0;
  private pending = Buffer.alloc(0);
  private index = 0;

  constructor(private readonly key: Buffer) {
    super();
    checkKey(key);
  }

  override _transform(data: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.pending = Buffer.concat([this.pending, data]);
      if (!this.header) {
        if (this.pending.length < HEADER_BYTES) {
          done();
          return;
        }
        this.readHeader(this.pending.subarray(0, HEADER_BYTES));
        this.pending = this.pending.subarray(HEADER_BYTES);
      }
      const sealedChunk = this.chunkBytes + TAG_BYTES;
      // As when encrypting, a full chunk is the last one only if nothing follows it.
      while (this.pending.length > sealedChunk) {
        this.push(this.open(this.pending.subarray(0, sealedChunk), false));
        this.pending = this.pending.subarray(sealedChunk);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      if (!this.header || this.pending.length < TAG_BYTES) {
        throw new FileCipherError('Encrypted file is incomplete');
      }
      this.push(this.open(this.pending, true));
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  private readHeader(header: Buffer): void {
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== FORMAT_VERSION) {
      throw new FileCipherError('Not an encrypted file of a known version');
    }
    const chunkBytes = header.readUInt32BE(MAGIC.length + 1);
    checkChunkBytes(chunkBytes);
    this.header = Buffer.from(header);
    this.chunkBytes = chunkBytes;
    this.prefix = Buffer.from(header.subarray(MAGIC.length + 5));
  }

  private open(sealed: Buffer, last: boolean): Buffer {
    const header = this.header as Buffer;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, nonceFor(this.prefix, this.index++, last))
        .setAAD(header)
        .setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
      return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    } catch {
      throw new FileCipherError('Encrypted file failed its integrity check');
    }
  }
}

/** A new random key for one file. */
export function newFileKey(): Buffer {
  return randomBytes(FILE_KEY_BYTES);
}
