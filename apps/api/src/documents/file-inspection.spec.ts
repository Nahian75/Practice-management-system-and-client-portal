import { createHash, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { officeFile, zipOf } from '../../test/zip.js';
import { FileInspection, FileRefusedError, MAX_DOCUMENT_BYTES, type RefusalReason } from './file-inspection.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'ascii');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(200)]);
const WORD = officeFile('word/document.xml');
const EXCEL = officeFile('xl/workbook.xml');
const POWERPOINT = officeFile('ppt/presentation.xml');
const TEXT = Buffer.from('Note of call with the client, 5 October.\nThey accept the offer. Café £300.\n', 'utf8');
const EMAIL = Buffer.from('From: client@example.com\r\nTo: fee.earner@practice.test\r\nSubject: Offer\r\n\r\nWe accept.\r\n', 'utf8');

/** Runs `data` through an inspection in small pieces, as an upload arrives; returns what passed through and the result. */
async function inspect(fileName: string, data: Buffer) {
  const inspection = new FileInspection(fileName);
  const passed: Buffer[] = [];
  const pieces = Array.from({ length: Math.ceil(data.length / 1000) }, (_, i) => data.subarray(i * 1000, (i + 1) * 1000));
  await pipeline(
    Readable.from(pieces),
    inspection,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        passed.push(chunk);
        done();
      },
    }),
  );
  return { passed: Buffer.concat(passed), result: inspection.result() };
}

const refusal = async (fileName: string, data: Buffer): Promise<RefusalReason | undefined> => {
  try {
    await inspect(fileName, data);
    return undefined;
  } catch (error) {
    if (error instanceof FileRefusedError) {
      return error.reason;
    }
    throw error;
  }
};

describe('file inspection', () => {
  it.each([
    ['contract.pdf', PDF, 'application/pdf'],
    ['letter.docx', WORD, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['accounts.xlsx', EXCEL, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', POWERPOINT, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['note.txt', TEXT, 'text/plain'],
    ['offer.eml', EMAIL, 'message/rfc822'],
    ['passport.jpg', JPEG, 'image/jpeg'],
    ['passport.JPEG', JPEG, 'image/jpeg'],
    ['plan.png', PNG, 'image/png'],
  ])('accepts %s as %s', async (fileName, data, mediaType) => {
    const { passed, result } = await inspect(fileName, data);

    expect(passed).toEqual(data);
    expect(result).toEqual({ mediaType, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest() });
  });

  describe('refuses a file that is not what its name says', () => {
    it.each([
      ['a web page named .pdf', 'contract.pdf', Buffer.from('<html><script>alert(1)</script></html>')],
      ['a PDF named .png', 'plan.png', PDF],
      ['a PNG named .jpg', 'photo.jpg', PNG],
      ['a program named .pdf', 'contract.pdf', Buffer.concat([Buffer.from('MZ'), randomBytes(500)])],
      ['an Excel file named .docx', 'letter.docx', EXCEL],
      ['a plain ZIP named .docx', 'letter.docx', zipOf({ 'readme.txt': 'hello' })],
      ['a damaged Word file', 'letter.docx', WORD.subarray(0, WORD.length - 10)],
      ['a binary file named .txt', 'note.txt', randomBytes(500)],
      ['text with a null byte', 'note.txt', Buffer.from('fine\0not fine')],
      ['text cut part-way through a character', 'note.txt', Buffer.from('Caf\xc3', 'latin1')],
      ['an email without headers', 'offer.eml', Buffer.from('Just some words\n')],
      ['a PDF too short to have its signature', 'contract.pdf', Buffer.from('%PD')],
    ])('%s', async (_case, fileName, data) => {
      expect(await refusal(fileName, data)).toBe('type');
    });
  });

  it.each([
    ['web page', 'page.html'],
    ['script', 'run.js'],
    ['old Word format', 'letter.doc'],
    ['macro-enabled Word', 'letter.docm'],
    ['image that can carry script', 'logo.svg'],
    ['no extension', 'contract'],
    ['a name ending in a dot', 'contract.pdf.'],
  ])('refuses a %s by its name, whatever its content', async (_case, fileName) => {
    expect(await refusal(fileName, PDF)).toBe('type');
  });

  it('refuses a Word file holding macros, even named .docx', async () => {
    const withMacros = officeFile('word/document.xml', { 'word/vbaProject.bin': randomBytes(100) });

    expect(await refusal('letter.docx', withMacros)).toBe('macros');
  });

  it('refuses an empty file', async () => {
    expect(await refusal('note.txt', Buffer.alloc(0))).toBe('empty');
  });

  it('accepts exactly 50 MB, and stops reading as soon as a file passes it', async () => {
    const atLimit = Buffer.alloc(MAX_DOCUMENT_BYTES, 0x61);
    expect((await inspect('note.txt', atLimit)).result.sizeBytes).toBe(MAX_DOCUMENT_BYTES);

    // 60 MB, ending, so a missing limit fails this test rather than leaving it running.
    let produced = 0;
    const oversized = new Readable({
      read() {
        produced += 1024 * 1024;
        this.push(produced > 60 * 1024 * 1024 ? null : Buffer.alloc(1024 * 1024, 0x61));
      },
    });
    const inspection = new FileInspection('note.txt');
    await expect(pipeline(oversized, inspection, new Writable({ write: (_c, _e, done) => done() }))).rejects.toThrow(
      expect.objectContaining({ reason: 'too_large' }),
    );
    expect(produced).toBeLessThan(MAX_DOCUMENT_BYTES + 5 * 1024 * 1024);
  });

  it('refuses a PDF on its first bytes, before the rest arrives', async () => {
    let produced = 0;
    const source = new Readable({
      read() {
        produced += 1;
        this.push(produced === 1 ? Buffer.from('<html>') : randomBytes(1000));
      },
    });

    let passed = 0;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        passed += chunk.length;
        done();
      },
    });

    await expect(pipeline(source, new FileInspection('contract.pdf'), sink)).rejects.toThrow(expect.objectContaining({ reason: 'type' }));
    expect(passed).toBe(0);
    // Streams read about 16 KB ahead before the refusal reaches the source; no more.
    expect(produced).toBeLessThan(50);
  });

  it('finds the table of contents of a large Word file', async () => {
    const large = officeFile('word/document.xml', { 'word/media/scan.png': randomBytes(5 * 1024 * 1024) });

    expect((await inspect('scan.docx', large)).result.mediaType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});
