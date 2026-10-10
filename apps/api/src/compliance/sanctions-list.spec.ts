import { describe, expect, it } from 'vitest';
import { csvStream, SANCTIONS_HEADER, sanctionsCsv } from '../../test/sanctions.js';
import { nameTokens, normalizeName, parseSanctionsList, SanctionsListError } from './sanctions-list.js';

describe('parseSanctionsList', () => {
  it('groups every row of a designation and keeps its distinct names, births and nationalities', async () => {
    const csv = sanctionsCsv('31-Dec-2099', [
      { uniqueId: 'TST0001', names: ['Ivan', 'PETROV'], dob: '12/03/1961', nationality: '(1) Russia (2) Cyprus' },
      { uniqueId: 'TST0001', names: ['Ivan', 'PETROV'], nameType: 'Alias', dob: '00/00/1960' },
      { uniqueId: 'TST0001', names: ['Jean-Luc', 'PÉTROV'], nameType: 'Alias', dob: '00/07/1962' },
      { uniqueId: 'TST0002', names: ['Example Trading, Limited'], kind: 'Entity', otherInformation: 'Contains "quotes", commas' },
    ]);
    const list = await parseSanctionsList(csvStream(csv));

    expect(list.reportDate).toBe('2099-12-31');
    expect(list.designations).toHaveLength(2);
    const person = list.designations.find((item) => item.uniqueId === 'TST0001')!;
    expect(person).toMatchObject({ kind: 'individual', regime: 'The Test (Sanctions) Regulations 2099', dateDesignated: '2020-02-01',
      births: ['1960', '1961-03-12', '1962-07'], nationalities: ['CYPRUS', 'RUSSIA'] });
    expect(person.names).toEqual([
      { name: 'Ivan PETROV', normalized: 'IVAN PETROV', tokens: ['IVAN', 'PETROV'], isPrimary: true },
      { name: 'Jean-Luc PÉTROV', normalized: 'JEAN LUC PETROV', tokens: ['JEAN', 'LUC', 'PETROV'], isPrimary: false },
    ]);
    expect(list.designations.find((item) => item.uniqueId === 'TST0002')).toMatchObject({ kind: 'entity',
      names: [{ name: 'Example Trading, Limited', normalized: 'EXAMPLE TRADING LIMITED' }] });
    expect(list.sha256).toHaveLength(32);
    expect(list.byteSize).toBe(Buffer.byteLength(csv));
  });

  it('refuses a file that is not the official list', async () => {
    const refuse = (text: string | Buffer) => expect(parseSanctionsList(csvStream(text))).rejects.toBeInstanceOf(SanctionsListError);
    await refuse(`${SANCTIONS_HEADER}\r\n`);
    await refuse(`Report Date: 31-Foo-2099\r\n${SANCTIONS_HEADER}\r\n`);
    await refuse(`Report Date: 31-Dec-2099\r\n${SANCTIONS_HEADER.replace('Unique ID', 'Identifier')}\r\nx\r\n`);
    await refuse(sanctionsCsv('31-Dec-2099', []));
    await refuse(sanctionsCsv('31-Dec-2099', [{ uniqueId: 'TST0003', names: ['A Person'], kind: 'Aircraft' }]));
    await refuse(sanctionsCsv('31-Dec-2099', [{ uniqueId: 'bad id!', names: ['A Person'] }]));
    await refuse(Buffer.concat([Buffer.from(`Report Date: 31-Dec-2099\r\n${SANCTIONS_HEADER}\r\n`), Buffer.from([0xff, 0xfe])]));
  });

  it('normalizes names for matching regardless of accents, case and punctuation', () => {
    expect(normalizeName("  O'Brien-Smith, José ")).toBe('O BRIEN SMITH JOSE');
    expect(nameTokens('O BRIEN SMITH JOSE')).toEqual(['BRIEN', 'JOSE', 'SMITH']);
  });
});
