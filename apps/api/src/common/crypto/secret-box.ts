import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

export interface SealedSecret {
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

/**
 * Authenticated encryption for small secrets. `context` (an account ID) is
 * bound into the authentication tag, so a sealed secret copied onto another
 * account's row fails to open.
 */
export class SecretBox {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: number,
  ) {}

  seal(plaintext: Buffer, context: string): SealedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce).setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { keyVersion: this.keyVersion, nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  open(sealed: SealedSecret, context: string): Buffer {
    if (sealed.keyVersion !== this.keyVersion) {
      throw new SecretBoxError(`Secret was sealed with key version ${sealed.keyVersion}, current is ${this.keyVersion}`);
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, sealed.nonce)
        .setAAD(Buffer.from(context, 'utf8'))
        .setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    } catch {
      throw new SecretBoxError('Secret failed its integrity check');
    }
  }
}
