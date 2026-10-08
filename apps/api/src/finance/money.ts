const MAX_RATE_PENCE = 1_000_000n;
const MAX_BILL_AMOUNT_PENCE = 100_000_000n;
const POUNDS = /^(0|[1-9]\d{0,4})\.(\d{2})$/;
const BILL_AMOUNT = /^(0|[1-9]\d{0,6})\.(\d{2})$/;
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

export function billAmountToPence(value: string): string {
  const matched = BILL_AMOUNT.exec(value);
  if (!matched) {
    throw new Error('Invalid money amount');
  }
  const pence = BigInt(matched[1]!) * 100n + BigInt(matched[2]!);
  if (pence < 1n || pence > MAX_BILL_AMOUNT_PENCE) {
    throw new Error('Invalid money amount');
  }
  return pence.toString();
}

export function signedPenceToPounds(value: string): string {
  if (!/^-?\d+$/.test(value)) throw new Error('Invalid signed pence amount');
  const pence = BigInt(value);
  const absolute = pence < 0n ? -pence : pence;
  return `${pence < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
