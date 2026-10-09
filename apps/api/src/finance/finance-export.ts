/** RFC 4180-style CSV for finance downloads. Text that a spreadsheet could
 * interpret as a formula is made literal before quoting. */
export function financeCsv(rows: readonly (readonly (string | number | null)[])[]): Buffer {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return Buffer.from(`\uFEFF${csv}`, 'utf8');
}

function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
