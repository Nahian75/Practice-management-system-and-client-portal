import { inflateRawSync } from 'node:zlib';
import { FileRefusedError } from './file-refusal.js';

/** One entry of a ZIP file's table of contents (its central directory). */
export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  /** Where the entry's local header starts in the file. */
  offset: number;
}

const LOCAL_HEADER = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const MAX_NAME_BYTES = 1024;
/** Relationship parts are a few kilobytes; one bigger than this is refused. */
const MAX_RELS_BYTES = 256 * 1024;
const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;
const MAX_RELS_XML_BYTES = 1024 * 1024;

const isRelationshipsPart = (name: string) => name.toLowerCase().endsWith('.rels');

/**
 * Keeps, as an Office file streams past, a copy of every entry that looks
 * like a relationships part (`*.rels`), by where it starts. Which entries are
 * real is known only from the table of contents at the end of the file; the
 * copies kept are checked against it then.
 */
export class RelationshipPartCapture {
  private readonly captures = new Map<number, Buffer[]>();
  private readonly filling: { chunks: Buffer[]; remaining: number }[] = [];
  private carry = Buffer.alloc(0);
  private carryOffset = 0;
  private captured = 0;

  /** `chunk` is the file's bytes from `offset` on. */
  push(chunk: Buffer, offset: number): void {
    this.feed(chunk);
    const window = Buffer.concat([this.carry, chunk]);
    // A header and its name can be split between chunks: the last bytes wait for the next chunk.
    const keep = LOCAL_HEADER_BYTES + MAX_NAME_BYTES;
    this.scan(window, this.carryOffset, Math.max(0, window.length - keep));
    const kept = Math.min(window.length, keep);
    this.carry = Buffer.from(window.subarray(window.length - kept));
    this.carryOffset = offset + chunk.length - kept;
  }

  /** After the last chunk: what is left is checked too. */
  finish(): void {
    this.scan(this.carry, this.carryOffset, this.carry.length);
    this.carry = Buffer.alloc(0);
  }

  /** The bytes kept from `offset`, if an entry was seen starting there. */
  at(offset: number): Buffer | undefined {
    const chunks = this.captures.get(offset);
    return chunks && Buffer.concat(chunks);
  }

  private scan(window: Buffer, windowOffset: number, end: number): void {
    for (let at = window.indexOf('PK\x03\x04', 0, 'latin1'); at >= 0 && at < end; at = window.indexOf('PK\x03\x04', at + 1, 'latin1')) {
      if (at + LOCAL_HEADER_BYTES > window.length || window.readUInt32LE(at) !== LOCAL_HEADER) {
        continue;
      }
      const nameLength = window.readUInt16LE(at + 26);
      if (nameLength > MAX_NAME_BYTES || at + LOCAL_HEADER_BYTES + nameLength > window.length) {
        continue;
      }
      const absolute = windowOffset + at;
      if (this.captures.has(absolute) || !isRelationshipsPart(window.toString('utf8', at + LOCAL_HEADER_BYTES, at + LOCAL_HEADER_BYTES + nameLength))) {
        continue;
      }
      const first = Buffer.from(window.subarray(at, at + MAX_RELS_BYTES));
      this.count(first.length);
      const chunks = [first];
      this.captures.set(absolute, chunks);
      if (first.length < MAX_RELS_BYTES) {
        this.filling.push({ chunks, remaining: MAX_RELS_BYTES - first.length });
      }
    }
  }

  /** Adds a new chunk to the copies still being filled. */
  private feed(chunk: Buffer): void {
    for (const copy of this.filling) {
      const part = chunk.subarray(0, copy.remaining);
      if (part.length > 0) {
        copy.chunks.push(Buffer.from(part));
        copy.remaining -= part.length;
        this.count(part.length);
      }
    }
    for (let index = this.filling.length - 1; index >= 0; index--) {
      if ((this.filling[index]?.remaining ?? 0) <= 0) {
        this.filling.splice(index, 1);
      }
    }
  }

  private count(bytes: number): void {
    this.captured += bytes;
    if (this.captured > MAX_CAPTURED_BYTES) {
      throw new FileRefusedError('type');
    }
  }
}

/** Embedded objects that can carry programs: OLE objects and packages, ActiveX controls, macro-enabled files. */
const ACTIVE_PART = /\/activex\/|\/embeddings\/.*\.(bin|docm|dotm|xlsm|xltm|xlsb|xlam|pptm|potm|ppsm|ppam|sldm)$/;

/**
 * Refuses an Office file whose parts or relationships can bring in active
 * content: macros (however their part is named), embedded objects that can
 * hold programs, ActiveX controls, or links that make Office fetch content
 * from outside the file, such as a remote template. Hyperlinks, which only
 * open when clicked, and a template on the local disk are allowed.
 */
export function checkOfficeContent(entries: ZipEntry[], capture: RelationshipPartCapture): void {
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (name.endsWith('vbaproject.bin')) {
      throw new FileRefusedError('macros');
    }
    if (ACTIVE_PART.test(name)) {
      throw new FileRefusedError('active_content');
    }
  }
  for (const entry of entries.filter((candidate) => isRelationshipsPart(candidate.name))) {
    for (const relationship of relationshipsIn(partContent(entry, capture))) {
      if (/\/vbaproject$/i.test(relationship.type)) {
        throw new FileRefusedError('macros');
      }
      if (relationship.external && !/\/hyperlink$/i.test(relationship.type) && !isLocalFile(relationship.target)) {
        throw new FileRefusedError('active_content');
      }
    }
  }
}

/** The part's bytes, uncompressed, from the copy kept while the file streamed. Anything doubtful is refused. */
function partContent(entry: ZipEntry, capture: RelationshipPartCapture): Buffer {
  const refuse = () => new FileRefusedError('type');
  const kept = capture.at(entry.offset);
  if (!kept || kept.length < LOCAL_HEADER_BYTES || kept.readUInt32LE(0) !== LOCAL_HEADER || (entry.flags & 0x1) !== 0) {
    throw refuse();
  }
  const nameLength = kept.readUInt16LE(26);
  const start = LOCAL_HEADER_BYTES + nameLength + kept.readUInt16LE(28);
  if (kept.toString('utf8', LOCAL_HEADER_BYTES, LOCAL_HEADER_BYTES + nameLength) !== entry.name || start + entry.compressedSize > kept.length) {
    throw refuse();
  }
  const data = kept.subarray(start, start + entry.compressedSize);
  try {
    if (entry.method === 0) {
      return data;
    }
    if (entry.method === 8) {
      return inflateRawSync(data, { maxOutputLength: MAX_RELS_XML_BYTES });
    }
  } catch {
    throw refuse();
  }
  throw refuse();
}

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

const ANY_RELATIONSHIP = /<(?:[\w.-]+:)?Relationship\b/g;
// Quoted attribute values may hold ">", so a tag is matched attribute by attribute, not up to the next ">".
const RELATIONSHIP = /<(?:[\w.-]+:)?Relationship\b((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Each relationship in a relationships part, read as an XML parser would:
 * any namespace prefix, either quote, character references decoded. If any
 * relationship cannot be read with certainty, the file is refused.
 */
function relationshipsIn(content: Buffer): Relationship[] {
  const text = decodeText(content);
  const all = text.match(ANY_RELATIONSHIP)?.length ?? 0;
  const relationships = [...text.matchAll(RELATIONSHIP)].map((match) => {
    const attributes = new Map<string, string>();
    for (const [, name = '', double, single] of (match[1] ?? '').matchAll(ATTRIBUTE)) {
      attributes.set(name.replace(/^[\w.-]+:/, ''), decodeReferences(double ?? single ?? ''));
    }
    return {
      type: attributes.get('Type') ?? '',
      target: attributes.get('Target') ?? '',
      external: (attributes.get('TargetMode') ?? 'Internal') !== 'Internal',
    };
  });
  if (relationships.length !== all) {
    throw new FileRefusedError('type');
  }
  return relationships;
}

function decodeText(content: Buffer): string {
  if (content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString('utf16le');
  }
  if (content[0] === 0xfe && content[1] === 0xff) {
    return Buffer.from(content.subarray(2)).swap16().toString('utf16le');
  }
  if (content.includes(0)) {
    throw new FileRefusedError('type');
  }
  return content.toString('utf8');
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character references (`&#69;`, `&#x45;`) and the five named ones. */
function decodeReferences(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, reference: string) => {
    if (reference.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(reference.slice(2), 16));
    }
    if (reference.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(reference.slice(1), 10));
    }
    return NAMED_REFERENCES[reference] ?? whole;
  });
}

/** A template on the computer's own disk, such as file:///C:/Users/…/Normal.dotm: not fetched from anywhere. */
function isLocalFile(target: string): boolean {
  return /^file:\/\/\/[A-Za-z]:[\\/]/.test(target);
}
