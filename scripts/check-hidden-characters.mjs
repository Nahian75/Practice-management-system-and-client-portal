import { execFileSync } from 'node:child_process';

// Characters a reviewer cannot see but a compiler reads: control characters
// other than tab, line feed and carriage return, zero-width characters, line
// separators and text-direction controls ("Trojan Source"). In code and docs
// they must be written as escape sequences. Listed as numbers so this file
// cannot contain them itself.
const HIDDEN = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

const isHidden = (codePoint) => HIDDEN.some(([low, high]) => codePoint >= low && codePoint <= high);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// --all checks every tracked file; otherwise the staged version of each staged
// file, which is exactly what is about to be committed.
const all = process.argv.includes('--all');

/** Text files only: git reports binary files with "-" in --numstat. */
function filesToCheck() {
  const numstat = all
    ? git('diff', '--numstat', '--no-renames', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD')
    : git('diff', '--cached', '--numstat', '--no-renames', '--diff-filter=ACMR');
  return numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([added]) => added !== '-')
    .map(([, , path]) => path);
}

const findings = [];
for (const path of filesToCheck()) {
  const text = git('show', `${all ? 'HEAD' : ''}:${path}`);
  text.split('\n').forEach((line, index) => {
    let column = 0;
    for (const character of line) {
      column++;
      const codePoint = character.codePointAt(0);
      if (isHidden(codePoint)) {
        findings.push(`${path}:${index + 1}:${column} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`Hidden characters found. Write them as escape sequences, e.g. \\u202E:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
