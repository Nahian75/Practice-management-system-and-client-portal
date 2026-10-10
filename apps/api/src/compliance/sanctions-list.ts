import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

// Parses the official UK Sanctions List CSV (https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv).
// Its first line is "Report Date: DD-Mon-YYYY", then a header row, then one row per name and
// address of each designation, so one Unique ID spans many rows. Columns are found by name,
// so a reordered file still parses and a renamed required column fails loudly.

export const MAX_SANCTIONS_LIST_BYTES = 150 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
const MAX_DESIGNATIONS = 100_000;
const MAX_NAMES_PER_DESIGNATION = 500;
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const REQUIRED = ['Unique ID', 'Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6', 'Name type',
  'Regime Name', 'Designation Type', 'Date Designated', 'D.O.B', 'Nationality(/ies)'] as const;
type Column = typeof REQUIRED[number];
const KINDS: Record<string, SanctionsKind> = { individual: 'individual', entity: 'entity', ship: 'ship' };
const UNIQUE_ID = /^[A-Za-z0-9][A-Za-z0-9./-]{1,49}$/;
const UNSAFE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

export type SanctionsKind = 'individual' | 'entity' | 'ship';

export class SanctionsListError extends Error {
  override readonly name = 'SanctionsListError';
  constructor(readonly code: 'too_large' | 'format', message: string) { super(message); }
}

export interface SanctionsDesignation {
  uniqueId: string; kind: SanctionsKind; regime: string; dateDesignated: string | null;
  births: string[]; nationalities: string[];
  names: { name: string; normalized: string; tokens: string[]; isPrimary: boolean }[];
}
export interface ParsedSanctionsList { reportDate: string; sha256: Buffer; byteSize: number; designations: SanctionsDesignation[] }

/** Upper case, accents removed, every run of non-letters and non-digits a single space. */
export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The distinct words of a normalized name, at least two characters long, sorted. */
export function nameTokens(normalized: string): string[] {
  return [...new Set(normalized.split(' ').filter((token) => token.length >= 2))].sort();
}

export async function parseSanctionsList(stream: Readable): Promise<ParsedSanctionsList> {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = new CsvRecords();
  let byteSize = 0;
  let reportDate: string | undefined;
  let columns: Map<Column, number> | undefined;
  let rows = 0;
  const designations = new Map<string, Building>();

  const take = (record: string[]) => {
    if (reportDate === undefined) {
      reportDate = parseReportDate(record);
    } else if (columns === undefined) {
      columns = headerColumns(record);
    } else {
      rows += 1;
      if (rows > MAX_ROWS) throw new SanctionsListError('too_large', 'The sanctions list has too many rows');
      addRow(designations, record, columns);
    }
  };

  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      byteSize += chunk.length;
      if (byteSize > MAX_SANCTIONS_LIST_BYTES) throw new SanctionsListError('too_large', 'The sanctions list is too large');
      hash.update(chunk);
      for (const record of reader.push(decoder.decode(chunk, { stream: true }))) take(record);
    }
    for (const record of reader.end(decoder.decode())) take(record);
  } catch (error) {
    if (error instanceof SanctionsListError) throw error;
    if (error instanceof TypeError) throw new SanctionsListError('format', 'The sanctions list must be UTF-8 text');
    throw error;
  }
  if (!reportDate || !columns || designations.size === 0) {
    throw new SanctionsListError('format', 'The sanctions list has no designations');
  }
  return {
    reportDate, sha256: hash.digest(), byteSize,
    designations: [...designations.values()].map((item) => ({
      uniqueId: item.uniqueId, kind: item.kind, regime: item.regime, dateDesignated: item.dateDesignated,
      births: [...item.births].sort(), nationalities: [...item.nationalities].sort(), names: [...item.names.values()],
    })),
  };
}

interface Building extends Omit<SanctionsDesignation, 'births' | 'nationalities' | 'names'> {
  births: Set<string>; nationalities: Set<string>; names: Map<string, SanctionsDesignation['names'][number]>;
}

function parseReportDate(record: string[]): string {
  const match = /^Report Date:\s*(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec((record[0] ?? '').replace(/^\uFEFF/, '').trim());
  const month = match ? MONTHS[match[2]!.toLowerCase()] : undefined;
  const date = match && month ? `${match[3]}-${month}-${match[1]}` : undefined;
  if (!date || !isRealDate(date)) throw new SanctionsListError('format', 'The sanctions list does not start with its report date');
  return date;
}

function headerColumns(record: string[]): Map<Column, number> {
  const columns = new Map<Column, number>();
  for (const name of REQUIRED) {
    const index = record.findIndex((cell) => cell.trim() === name);
    if (index < 0) throw new SanctionsListError('format', `The sanctions list has no "${name}" column`);
    columns.set(name, index);
  }
  return columns;
}

function addRow(designations: Map<string, Building>, record: string[], columns: Map<Column, number>): void {
  const cell = (name: Column) => clean(record[columns.get(name)!] ?? '');
  const uniqueId = cell('Unique ID');
  if (!UNIQUE_ID.test(uniqueId)) throw new SanctionsListError('format', 'A sanctions list row has an invalid Unique ID');
  let item = designations.get(uniqueId);
  if (!item) {
    const kind = KINDS[cell('Designation Type').toLowerCase()];
    const regime = cell('Regime Name').slice(0, 500);
    if (!kind || !regime) throw new SanctionsListError('format', `Designation ${uniqueId} has no type or regime`);
    if (designations.size >= MAX_DESIGNATIONS) throw new SanctionsListError('too_large', 'The sanctions list has too many designations');
    item = { uniqueId, kind, regime, dateDesignated: listDate(cell('Date Designated')), births: new Set(), nationalities: new Set(), names: new Map() };
    designations.set(uniqueId, item);
  }
  const birth = listBirth(cell('D.O.B'));
  if (birth && item.births.size < 50) item.births.add(birth);
  for (const nationality of cell('Nationality(/ies)').split(/\(\d+\)/)) {
    const normalized = normalizeName(nationality);
    if (normalized && item.nationalities.size < 50) item.nationalities.add(normalized);
  }
  const name = ['Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6'].map((part) => cell(part as Column))
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 500);
  const normalized = normalizeName(name).slice(0, 500);
  const tokens = nameTokens(normalized).slice(0, 60);
  if (!/[\p{L}\p{N}]/u.test(name) || tokens.length === 0) return;
  const isPrimary = cell('Name type').toLowerCase() === 'primary name';
  const existing = item.names.get(normalized);
  if (existing) {
    existing.isPrimary ||= isPrimary;
  } else if (item.names.size < MAX_NAMES_PER_DESIGNATION) {
    item.names.set(normalized, { name, normalized, tokens, isPrimary });
  }
}

/** Removes control and text-direction characters rather than rejecting the whole official list. */
function clean(value: string): string {
  return value.replace(UNSAFE, ' ').trim();
}

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** "dd/mm/yyyy" to an ISO date, or null when absent or not a real date. */
function listDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const date = match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  return date && isRealDate(date) ? date : null;
}

/** A birth date "can be partially known": unknown day or month parts are 00 or missing. */
function listBirth(value: string): string | null {
  const match = /^(?:(\d{2})\/)?(?:(\d{2})\/)?(\d{4})$/.exec(value);
  if (!match) return null;
  const year = Number(match[3]);
  if (year < 1800 || year > 2100) return null;
  const [day, month] = match[2] === undefined ? [undefined, match[1]] : [match[1], match[2]];
  if (!month || month === '00') return match[3]!;
  if (Number(month) > 12) return match[3]!;
  if (!day || day === '00') return `${match[3]}-${month}`;
  const full = `${match[3]}-${month}-${day}`;
  return isRealDate(full) ? full : `${match[3]}-${month}`;
}

/**
 * A streaming RFC 4180 reader. A quote inside an unquoted field is kept as an ordinary
 * character, because the official file is authoritative and must not be refused for it.
 */
class CsvRecords {
  private field = '';
  private record: string[] = [];
  private quoted = false;
  private quotePending = false;
  private carriageReturn = false;

  push(text: string): string[][] {
    const records: string[][] = [];
    for (const character of text) {
      if (this.carriageReturn) {
        this.carriageReturn = false;
        if (character === '\n') continue;
      }
      if (this.quotePending) {
        this.quotePending = false;
        if (character === '"') { this.field += '"'; continue; }
        this.quoted = false;
      }
      if (this.quoted) {
        if (character === '"') this.quotePending = true;
        else this.field += character;
        continue;
      }
      if (character === '"' && this.field.length === 0) {
        this.quoted = true;
      } else if (character === ',') {
        this.record.push(this.field);
        this.field = '';
      } else if (character === '\n' || character === '\r') {
        this.carriageReturn = character === '\r';
        this.finish(records);
      } else {
        this.field += character;
      }
    }
    return records;
  }

  end(text: string): string[][] {
    const records = this.push(text);
    if (this.quoted && !this.quotePending) throw new SanctionsListError('format', 'The sanctions list has an unclosed quote');
    this.quoted = false;
    this.quotePending = false;
    if (this.field.length > 0 || this.record.length > 0) this.finish(records);
    return records;
  }

  private finish(records: string[][]): void {
    this.record.push(this.field);
    this.field = '';
    if (this.record.some((cell) => cell.length > 0)) records.push(this.record);
    this.record = [];
  }
}
