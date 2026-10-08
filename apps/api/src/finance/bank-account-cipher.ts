import { createHmac, randomUUID } from 'node:crypto';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';

const CURRENT_FINANCE_KEY_VERSION = 1;
const FINGERPRINT_DOMAIN = 'stass.finance.bank-account.fingerprint.v1';

export interface BankDetails {
  sortCode: string;
  accountNumber: string;
}

export interface SealedBankDetails extends SealedSecret {
  context: string;
  fingerprint: Buffer;
  lastFour: string;
}

/** Keeps the firm's own bank details unreadable in PostgreSQL. */
export class BankAccountCipher {
  private readonly box: SecretBox;
  private readonly fingerprintKey: Buffer;

  constructor(key: Buffer) {
    this.box = new SecretBox(key, CURRENT_FINANCE_KEY_VERSION);
    this.fingerprintKey = createHmac('sha256', key).update(FINGERPRINT_DOMAIN).digest();
  }

  seal(details: BankDetails): SealedBankDetails {
    const context = randomUUID();
    const canonical = `${details.sortCode.replaceAll('-', '')}:${details.accountNumber}`;
    return {
      context,
      fingerprint: createHmac('sha256', this.fingerprintKey).update(canonical).digest(),
      lastFour: details.accountNumber.slice(-4),
      ...this.box.seal(Buffer.from(canonical, 'utf8'), context),
    };
  }

  open(sealed: SealedBankDetails): BankDetails {
    const [sortCode, accountNumber] = this.box.open(sealed, sealed.context).toString('utf8').split(':');
    if (!sortCode || !accountNumber || !/^\d{6}$/.test(sortCode) || !/^\d{8}$/.test(accountNumber)) {
      throw new Error('Bank details are not valid');
    }
    return {
      sortCode: `${sortCode.slice(0, 2)}-${sortCode.slice(2, 4)}-${sortCode.slice(4)}`,
      accountNumber,
    };
  }
}
