import { describe, expect, it } from 'vitest';
import { financeCsv } from './finance-export.js';

describe('finance CSV exports', () => {
  it('emits a UTF-8 BOM and CRLF rows', () => {
    expect(financeCsv([['Reference'], ['ABC']]).toString('utf8')).toBe('\uFEFF"Reference"\r\n"ABC"\r\n');
  });

  it('quotes every cell and escapes embedded quotes and commas', () => {
    expect(financeCsv([['Quoted "text", with comma']]).toString('utf8')).toBe('\uFEFF"Quoted ""text"", with comma"\r\n');
  });

  it('makes every spreadsheet formula prefix literal', () => {
    const csv = financeCsv([['=2+2', '+SUM(A1:A2)', '-12.34', '@command', '\ttab', '\rreturn']]).toString('utf8');
    expect(csv).toBe('\uFEFF"\'=2+2","\'+SUM(A1:A2)","\'-12.34","\'@command","\'\ttab","\'\rreturn"\r\n');
  });
});
