import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import type { DocumentMediaType } from '../database/schema.js';

/** 50 MB, as the database's own check (migration 0024). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export type RefusalReason = 'empty' | 'too_large' | 'type' | 'macros';

export class FileRefusedError extends Error {
  override readonly name = 'FileRefusedError';

  constructor(readonly reason: RefusalReason) {
    super(`File refused: ${reason}`);
  }
}

export interface InspectedFile {
  mediaType: DocumentMediaType;
  sizeBytes: number;
  sha256: Buffer;
}

type Kind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'email' | 'jpeg' | 'png';

/** What a file's name claims, and the type it is stored as once its content agrees. */
const KINDS: Readonly<Record<string, Kind>> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.txt': 'text',
  '.eml': 'email',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
};

const MEDIA_TYPES: Readonly<Record<Kind, DocumentMediaType>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'text/plain',
  email: 'message/rfc822',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** How each kind starts. Text and email have no signature; their content is checked as it streams. */
const SIGNATURES: Readonly<Partial<Record<Kind, Buffer>>> = {
  pdf: Buffer.from('%PDF-', 'ascii'),
  docx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  xlsx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  pptx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

/** The part every Word, Excel or PowerPoint file has. */
const MAIN_PARTS: Readonly<Partial<Record<Kind, string>>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

/** An Office file's table of contents is at its end; one larger than this is refused. */
const ZIP_TAIL_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;

/**
 * Passes a file through unchanged while checking it: its size (refused past
 * 50 MB, as soon as it gets there), its SHA-256 fingerprint, and that its
 * content is what its name says. The type comes from the name's extension
 * only when the content agrees; a file that disagrees is refused, never
 * relabelled. Word, Excel and PowerPoint files must be the current formats
 * and hold no macros.
 */
export class FileInspection extends Transform {
  private readonly kind: Kind | undefined;
  private readonly hash = createHash('sha256');
  private readonly text = new TextDecoder('utf-8', { fatal: true });
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private size = 0;
  private inspected: InspectedFile | undefined;

  constructor(fileName: string) {
    super();
    this.kind = KINDS[extname(fileName).toLowerCase()];
  }

  /** The checked file, once everything has passed through. */
  result(): InspectedFile {
    if (!this.inspected) {
      throw new Error('The file has not been read to its end');
    }
    return this.inspected;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      if (!this.kind) {
        throw new FileRefusedError('type');
      }
      this.size += chunk.length;
      if (this.size > MAX_DOCUMENT_BYTES) {
        throw new FileRefusedError('too_large');
      }
      this.hash.update(chunk);
      this.checkStart(chunk);
      this.checkContent(chunk);
      this.keepTail(chunk);
      done(null, chunk);
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      if (!this.kind) {
        throw new FileRefusedError('type');
      }
      if (this.size === 0) {
        throw new FileRefusedError('empty');
      }
      const signature = SIGNATURES[this.kind];
      if (signature && !this.head.subarray(0, signature.length).equals(signature)) {
        throw new FileRefusedError('type');
      }
      if (this.kind === 'text' || this.kind === 'email') {
        this.finishText();
      }
      if (this.kind === 'email' && !/^[!-9;-~]+:/.test(this.head.toString('latin1'))) {
        throw new FileRefusedError('type');
      }
      const mainPart = MAIN_PARTS[this.kind];
      if (mainPart) {
        checkOfficeFile(zipEntryNames(Buffer.concat(this.tail), this.size), mainPart);
      }
      this.inspected = { mediaType: MEDIA_TYPES[this.kind], sizeBytes: this.size, sha256: this.hash.digest() };
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  /** Refuses as soon as the first bytes show the file is not what its name says. */
  private checkStart(chunk: Buffer): void {
    const signature = this.kind && SIGNATURES[this.kind];
    if (!signature || this.head.length >= signature.length) {
      return;
    }
    this.head = Buffer.concat([this.head, chunk.subarray(0, signature.length - this.head.length)]);
    const known = Math.min(this.head.length, signature.length);
    if (!this.head.subarray(0, known).equals(signature.subarray(0, known))) {
      throw new FileRefusedError('type');
    }
  }

  /** Text and emails must be valid UTF-8 with no null bytes: not a binary file renamed. */
  private checkContent(chunk: Buffer): void {
    if (this.kind !== 'text' && this.kind !== 'email') {
      return;
    }
    if (this.head.length < 200) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 200 - this.head.length)]);
    }
    if (chunk.includes(0)) {
      throw new FileRefusedError('type');
    }
    try {
      this.text.decode(chunk, { stream: true });
    } catch {
      throw new FileRefusedError('type');
    }
  }

  /** A text file must not end part-way through a character. */
  private finishText(): void {
    try {
      this.text.decode();
    } catch {
      throw new FileRefusedError('type');
    }
  }

  /** Keeps only the last bytes of an Office file, where its table of contents is. */
  private keepTail(chunk: Buffer): void {
    if (!this.kind || !MAIN_PARTS[this.kind]) {
      return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.length ?? 0) >= ZIP_TAIL_BYTES) {
      this.tailBytes -= this.tail.shift()?.length ?? 0;
    }
  }
}

function checkOfficeFile(names: string[], mainPart: string): void {
  if (names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'))) {
    throw new FileRefusedError('macros');
  }
  if (!names.includes('[Content_Types].xml') || !names.includes(mainPart)) {
    throw new FileRefusedError('type');
  }
}

/**
 * The names in a ZIP file's central directory, read from the file's last
 * bytes (`tail`) given its full size. Anything malformed, too large, or ZIP64
 * (never needed under 50 MB) is refused as the wrong type.
 */
function zipEntryNames(tail: Buffer, fileSize: number): string[] {
  const END_RECORD = 0x06054b50;
  const DIRECTORY_ENTRY = 0x02014b50;
  const refuse = () => new FileRefusedError('type');

  let end = -1;
  for (let at = tail.length - 22; at >= Math.max(0, tail.length - 22 - 0xffff); at--) {
    if (tail.readUInt32LE(at) === END_RECORD) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    throw refuse();
  }
  const entries = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || entries > MAX_ZIP_ENTRIES) {
    throw refuse();
  }
  const start = directoryOffset - (fileSize - tail.length);
  if (start < 0 || start + directorySize > end) {
    throw refuse();
  }

  const names: string[] = [];
  let at = start;
  for (let entry = 0; entry < entries; entry++) {
    if (at + 46 > end || tail.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw refuse();
    }
    const nameLength = tail.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + tail.readUInt16LE(at + 30) + tail.readUInt16LE(at + 32);
    if (next > end) {
      throw refuse();
    }
    names.push(tail.toString('utf8', at + 46, at + 46 + nameLength));
    at = next;
  }
  return names;
}
