const MAX_RATE_PENCE = 1_000_000n;
const POUNDS = /^(0|[1-9]\d{0,4})\.(\d{2})$/;
const PENCE = /^\d+$/;

export function poundsToPence(value: string): string {
  const matched = POUNDS.exec(value);
  if (!matched) {
    throw new Error('Invalid money amount');
  }
  const pence = BigInt(matched[1]!) * 100n + BigInt(matched[2]!);
  if (pence > MAX_RATE_PENCE) {
    throw new Error('Invalid money amount');
  }
  return pence.toString();
}

export function penceToPounds(value: string): string {
  if (!PENCE.test(value)) {
    throw new Error('Invalid money amount');
  }
  const pence = BigInt(value);
  return `${pence / 100n}.${(pence % 100n).toString().padStart(2, '0')}`;
}
