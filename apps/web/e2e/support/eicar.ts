/**
 * The EICAR test file: harmless, and reported by every virus scanner as if it
 * were a virus. Built when the test runs, reversed in the source, so the
 * antivirus on a developer's machine does not quarantine this file. The same
 * as apps/api/test/eicar.ts.
 */
export function eicarTestFile(): Buffer {
  const backslash = String.fromCharCode(92);
  const dollar = String.fromCharCode(36);
  const reversed = `*H+H${dollar}!ELIF-TSET-SURIVITNA-DRADNATS-RACIE${dollar}}7)CC7)^P(45XZP${backslash}4[PA@%P!O5X`;
  return Buffer.from([...reversed].reverse().join(''), 'ascii');
}
