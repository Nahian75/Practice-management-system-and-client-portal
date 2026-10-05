import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from './content-disposition.js';

describe('attachmentDisposition', () => {
  it('gives a plain name as it is', () => {
    expect(attachmentDisposition('lease.pdf')).toBe(`attachment; filename="lease.pdf"; filename*=UTF-8''lease.pdf`);
  });

  it('keeps the exact name, encoded, and a plain fallback', () => {
    expect(attachmentDisposition('Café £300 ünterschrift.pdf')).toBe(
      `attachment; filename="Caf_ _300 _nterschrift.pdf"; filename*=UTF-8''Caf%C3%A9%20%C2%A3300%20%C3%BCnterschrift.pdf`,
    );
  });

  it.each([
    ['a quote', 'a".pdf'],
    ['a semicolon and another parameter', 'a.pdf"; filename="evil.html'],
    ['a backslash', `a${String.fromCharCode(92)}b.pdf`],
    ['a line break', `a${String.fromCharCode(13, 10)}Set-Cookie: x=1.pdf`],
  ])('cannot be broken out of with %s', (_case, fileName) => {
    const header = attachmentDisposition(fileName);

    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('; ')).toHaveLength(3);
  });
});
