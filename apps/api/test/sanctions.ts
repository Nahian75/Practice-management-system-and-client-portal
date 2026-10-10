import { Readable } from 'node:stream';

// The official file's header row, copied from the UK Sanctions List CSV of 8 October 2026.
export const SANCTIONS_HEADER = 'Last Updated,Unique ID,OFSI Group ID,UN Reference Number,Name 6,Name 1,Name 2,Name 3,Name 4,Name 5,'
  + 'Name type,Alias strength,Title,Name non-latin script,Non-latin script type,Non-latin script language,Regime Name,'
  + 'Designation Type,Designation source,Sanctions Imposed,Other Information,UK Statement of Reasons,Address Line 1,'
  + 'Address Line 2,Address Line 3,Address Line 4,Address Line 5,Address Line 6,Address Postal Code,Address Country,'
  + 'Phone number,Website,Email address,Date Designated,D.O.B,Nationality(/ies),National Identifier number,'
  + 'National Identifier additional information,Passport number,Passport additional information,Position,Gender,'
  + 'Town of birth,Country of birth,Type of entity,Subsidiaries,Parent company,Business registration number (s),'
  + 'IMO number,Current owner/operator (s),Previous owner/operator (s),Current believed flag of ship,Previous flags,'
  + 'Type of ship,Tonnage of ship,Length of ship,Year Built,Hull identification number (HIN)';
const COLUMNS = SANCTIONS_HEADER.split(',');
const LINE_END = String.fromCharCode(13, 10);

export interface SanctionsRow {
  uniqueId: string; names: string[]; nameType?: string; kind?: string; regime?: string;
  dob?: string; nationality?: string; dateDesignated?: string; otherInformation?: string;
}

function quote(value: string): string {
  const needsQuotes = [',', '"', String.fromCharCode(13), String.fromCharCode(10)].some((mark) => value.includes(mark));
  return needsQuotes ? `"${value.split('"').join('""')}"` : value;
}

/** A sanctions list CSV in the official layout: the report-date line, the header, then one row per name. */
export function sanctionsCsv(reportDate: string, rows: SanctionsRow[]): string {
  const lines = [`Report Date: ${reportDate}`, SANCTIONS_HEADER];
  for (const row of rows) {
    const parts = [...row.names];
    const cells = new Map<string, string>([
      ['Last Updated', '01/01/2026'], ['Unique ID', row.uniqueId], ['Name type', row.nameType ?? 'Primary Name'],
      ['Regime Name', row.regime ?? 'The Test (Sanctions) Regulations 2099'], ['Designation Type', row.kind ?? 'Individual'],
      ['Date Designated', row.dateDesignated ?? '01/02/2020'], ['D.O.B', row.dob ?? ''], ['Nationality(/ies)', row.nationality ?? ''],
      ['Other Information', row.otherInformation ?? ''], ['Name 6', parts.pop() ?? ''],
    ]);
    parts.forEach((part, index) => cells.set(`Name ${index + 1}`, part));
    lines.push(COLUMNS.map((column) => quote(cells.get(column) ?? '')).join(','));
  }
  return lines.join(LINE_END) + LINE_END;
}

export const csvStream = (text: string | Buffer) => Readable.from([Buffer.from(text)]);
