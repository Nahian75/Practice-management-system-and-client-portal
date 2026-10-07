import { describe, expect, it } from 'vitest';
import { MailCipher } from './mail-cipher.js';
import type { MailMessage } from './mailer.js';

const MESSAGE: MailMessage = {
  to: 'person@example.com',
  subject: 'A private subject',
  text: 'A one-time token: secret-token',
};
const METADATA = {
  kind: 'security_notice' as const,
  recipientAccountId: '0199bd34-8400-7000-8000-000000000001',
  resourceType: null,
  resourceId: null,
};

describe('MailCipher', () => {
  it('opens an envelope only with its authenticated metadata', () => {
    const cipher = new MailCipher(Buffer.alloc(32, 1), 1);
    const sealed = cipher.seal(MESSAGE, METADATA);

    expect(cipher.open(sealed, METADATA)).toEqual(MESSAGE);
    expect(JSON.stringify(sealed)).not.toContain(MESSAGE.to);
    expect(JSON.stringify(sealed)).not.toContain(MESSAGE.subject);
    expect(JSON.stringify(sealed)).not.toContain('secret-token');
  });

  it('refuses an envelope copied to a different account', () => {
    const cipher = new MailCipher(Buffer.alloc(32, 1), 1);
    const sealed = cipher.seal(MESSAGE, METADATA);

    expect(() =>
      cipher.open(sealed, {
        ...METADATA,
        recipientAccountId: '0199bd34-8400-7000-8000-000000000099',
      }),
    ).toThrow(/integrity/);
  });

  it('refuses a key from another installation', () => {
    const first = new MailCipher(Buffer.alloc(32, 1), 1);
    const second = new MailCipher(Buffer.alloc(32, 2), 1);

    expect(() => second.open(first.seal(MESSAGE, METADATA), METADATA)).toThrow(/integrity/);
  });
});
