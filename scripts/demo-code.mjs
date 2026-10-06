// Local demo only: shows the current 6-digit security code for the demo login,
// from the setup key in DEMO-LOGIN.txt (which git ignores), so the local demo
// can be tried without a phone. A real account's code comes only from its
// owner's authenticator app; nothing like this exists for a real system.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const loginFile = new URL('../DEMO-LOGIN.txt', import.meta.url);
let key;
try {
  key = /setup key" and type:\s+([A-Z2-7]{16,})/.exec(readFileSync(loginFile, 'utf8'))?.[1];
} catch {
  key = undefined;
}
if (!key) {
  console.error('No setup key found in DEMO-LOGIN.txt.');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bits = [...key].map((character) => ALPHABET.indexOf(character).toString(2).padStart(5, '0')).join('');
const secret = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));

// RFC 6238, as authenticator apps compute it: SHA-1, 6 digits, 30-second steps.
const step = Math.floor(Date.now() / 30_000);
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(step));
const digest = createHmac('sha1', secret).update(counter).digest();
const offset = (digest.at(-1) ?? 0) & 0x0f;
const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
const secondsLeft = 30 - Math.floor((Date.now() / 1000) % 30);

console.log('');
console.log(`  Security code:  ${code.slice(0, 3)} ${code.slice(3)}`);
console.log(`  Good for ${secondsLeft} more seconds. Each code works once: for the next sign-in, run this again.`);
console.log('');
