import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const HEADER = ['date', 'amount', 'reference', 'description'];
const SAFE_TEXT = /^(?=.*[\p{L}\p{N}])(?![=+\-@])[^\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]+$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^(-?)(0|[1-9]\d{0,9})\.(\d{2})$/;

export class StatementCsvError extends Error {
  override readonly name = 'StatementCsvError';
}

export interface ParsedStatementRow {
  occurredOn: string;
  amountPence: string;
  reference: string;
  description: string;
  fingerprint: string;
}

export interface ParsedStatementCsv {
  hash: Buffer;
  rows: ParsedStatementRow[];
}

export async function parseStatementCsv(stream: Readable): Promise<ParsedStatementCsv> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > MAX_CSV_BYTES) throw new StatementCsvError('The statement CSV is larger than 5 MB');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StatementCsvError('The statement CSV must be UTF-8 text');
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const records = parseCsv(source);
  if (records.length < 2) throw new StatementCsvError('The statement CSV needs a header and at least one row');
  if (records.length - 1 > MAX_ROWS) throw new StatementCsvError('The statement CSV has more than 10000 rows');
  if (records[0]!.length !== HEADER.length || !HEADER.every((name, index) => records[0]![index] === name)) {
    throw new StatementCsvError('Use the exact CSV header: date,amount,reference,description');
  }
  const rows = records.slice(1).map((record, index) => parseRow(record, index + 2));
  return { hash: createHash('sha256').update(bytes).digest(), rows };
}

export function signedAmountToPence(value: string, allowZero = false): string {
  const match = MONEY.exec(value);
  if (!match) throw new StatementCsvError('Use pounds with exactly two decimal places');
  const amount = BigInt(match[2]!) * 100n + BigInt(match[3]!);
  const signed = match[1] === '-' ? -amount : amount;
  if ((!allowZero && signed === 0n) || signed < -1_000_000_000_000n || signed > 1_000_000_000_000n) {
    throw new StatementCsvError('The amount is outside the supported range');
  }
  return signed.toString();
}

function parseRow(record: string[], line: number): ParsedStatementRow {
  if (record.length !== HEADER.length) throw new StatementCsvError(`CSV row ${line} does not have four columns`);
  const [occurredOn, amount, rawReference, rawDescription] = record as [string, string, string, string];
  const parsedDate = new Date(`${occurredOn}T00:00:00Z`);
  if (!DATE.test(occurredOn) || Number.isNaN(parsedDate.valueOf())
    || parsedDate.toISOString().slice(0, 10) !== occurredOn) {
    throw new StatementCsvError(`CSV row ${line} has an invalid date`);
  }
  const amountPence = signedAmountToPence(amount);
  const reference = safeCell(rawReference, 100, line, 'reference');
  const description = safeCell(rawDescription, 500, line, 'description');
  const canonical = JSON.stringify([occurredOn, amountPence, reference, description]);
  return {
    occurredOn,
    amountPence,
    reference,
    description,
    fingerprint: createHash('sha256').update(canonical).digest('base64'),
  };
}

function safeCell(value: string, max: number, line: number, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max || !SAFE_TEXT.test(trimmed)) {
    throw new StatementCsvError(`CSV row ${line} has an unsafe ${label}`);
  }
  return trimmed;
}

function parseCsv(source: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; afterQuote = true; }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new StatementCsvError('The statement CSV has characters after a closing quote');
    }
    if (character === '"') {
      if (field.length > 0 || afterQuote) throw new StatementCsvError('The statement CSV has an invalid quote');
      quoted = true;
    } else if (character === ',') {
      record.push(field); field = ''; afterQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field); field = ''; afterQuote = false;
      if (record.some((cell) => cell.length > 0)) records.push(record);
      record = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new StatementCsvError('The statement CSV has an unclosed quote');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((cell) => cell.length > 0)) records.push(record);
  }
  return records;
}
