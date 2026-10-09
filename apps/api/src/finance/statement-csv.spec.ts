import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseStatementCsv, signedAmountToPence } from './statement-csv.js';

const stream = (value: string | Buffer) => Readable.from([value]);

describe('statement CSV parsing', () => {
  it('parses quoted UTF-8 data and signed pounds without treating cells as formulas', async () => {
    const parsed = await parseStatementCsv(stream(
      'date,amount,reference,description\r\n2026-10-01,12.34,ABC123,"Client receipt, October"\r\n2026-10-02,-2.34,OUT1,Refund\r\n',
    ));
    expect(parsed.hash).toHaveLength(32);
    expect(parsed.rows).toEqual([
      expect.objectContaining({ occurredOn: '2026-10-01', amountPence: '1234', reference: 'ABC123', description: 'Client receipt, October' }),
      expect.objectContaining({ occurredOn: '2026-10-02', amountPence: '-234', reference: 'OUT1', description: 'Refund' }),
    ]);
    expect(parsed.rows[0]!.fingerprint).toBeTruthy();
  });

  it.each([
    ['wrong header', 'Date,amount,reference,description\n2026-10-01,1.00,R1,Receipt'],
    ['formula reference', 'date,amount,reference,description\n2026-10-01,1.00,=HYPERLINK(1),Receipt'],
    ['control character', 'date,amount,reference,description\n2026-10-01,1.00,R1,"Bad\ttext"'],
    ['unclosed quote', 'date,amount,reference,description\n2026-10-01,1.00,R1,"Receipt'],
    ['extra column', 'date,amount,reference,description\n2026-10-01,1.00,R1,Receipt,extra'],
    ['zero row', 'date,amount,reference,description\n2026-10-01,0.00,R1,Receipt'],
    ['impossible date', 'date,amount,reference,description\n2026-02-30,1.00,R1,Receipt'],
  ])('rejects %s', async (_label, csv) => {
    await expect(parseStatementCsv(stream(csv))).rejects.toThrow();
  });

  it('rejects invalid UTF-8 and oversize input', async () => {
    await expect(parseStatementCsv(stream(Buffer.from([0xff])))).rejects.toThrow(/UTF-8/);
    await expect(parseStatementCsv(stream(Buffer.alloc(5 * 1024 * 1024 + 1, 65)))).rejects.toThrow(/larger/);
  });

  it('parses statement balances including zero', () => {
    expect(signedAmountToPence('0.00', true)).toBe('0');
    expect(signedAmountToPence('-123.45', true)).toBe('-12345');
    expect(() => signedAmountToPence('1')).toThrow();
  });
});
