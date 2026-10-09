import { randomUUID } from 'node:crypto';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';

const CURRENT_FINANCE_KEY_VERSION = 1;

export interface PaymentDetails {
  name: string;
  sortCode: string;
  accountNumber: string;
}

export interface SealedPaymentDetails extends SealedSecret {
  context: string;
}

/** Keeps a payment recipient unreadable in PostgreSQL. */
export class PaymentDetailsCipher {
  private readonly box: SecretBox;

  constructor(key: Buffer) {
    this.box = new SecretBox(key, CURRENT_FINANCE_KEY_VERSION);
  }

  seal(details: PaymentDetails): SealedPaymentDetails {
    const context = randomUUID();
    return {
      context,
      ...this.box.seal(Buffer.from(JSON.stringify(details), 'utf8'), context),
    };
  }

  open(sealed: SealedPaymentDetails): PaymentDetails {
    const parsed: unknown = JSON.parse(this.box.open(sealed, sealed.context).toString('utf8'));
    if (!isPaymentDetails(parsed)) throw new Error('Payment details are not valid');
    return parsed;
  }
}

function isPaymentDetails(value: unknown): value is PaymentDetails {
  if (typeof value !== 'object' || value === null) return false;
  const details = value as Record<string, unknown>;
  return typeof details.name === 'string' && details.name.length > 0 && details.name.length <= 200
    && typeof details.sortCode === 'string' && /^\d{2}-\d{2}-\d{2}$/.test(details.sortCode)
    && typeof details.accountNumber === 'string' && /^\d{8}$/.test(details.accountNumber);
}
