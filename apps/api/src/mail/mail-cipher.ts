import { z } from 'zod';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import type { EmailKind } from '../database/schema.js';
import type { MailMessage } from './mailer.js';

export interface MailEnvelopeMetadata {
  kind: EmailKind;
  recipientAccountId: string | null;
  resourceType: string | null;
  resourceId: string | null;
}

const payloadSchema = z.strictObject({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
});

export class MailCipher {
  private readonly box: SecretBox;

  constructor(key: Buffer, keyVersion: number) {
    this.box = new SecretBox(key, keyVersion);
  }

  seal(message: MailMessage, metadata: MailEnvelopeMetadata): SealedSecret {
    return this.box.seal(Buffer.from(JSON.stringify(message), 'utf8'), context(metadata));
  }

  open(sealed: SealedSecret, metadata: MailEnvelopeMetadata): MailMessage {
    const plaintext = this.box.open(sealed, context(metadata));
    return payloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
  }
}

function context(metadata: MailEnvelopeMetadata): string {
  return JSON.stringify([
    'email-outbox-v1',
    metadata.kind,
    metadata.recipientAccountId,
    metadata.resourceType,
    metadata.resourceId,
  ]);
}
