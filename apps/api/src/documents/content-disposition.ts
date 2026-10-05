const QUOTE = '"';
const BACKSLASH = String.fromCharCode(92);
// Safe inside quotes by the standard; replaced anyway, for clients that parse headers loosely.
const UNSAFE_IN_PLAIN = [QUOTE, BACKSLASH, ';'];

/**
 * `Content-Disposition` for a download (RFC 6266): always an attachment, so
 * the browser saves the file instead of showing it. The name is given twice:
 * plain ASCII, with anything else replaced, for old clients; and exactly,
 * percent-encoded, for the rest. Nothing in a name can end the header early.
 */
export function attachmentDisposition(fileName: string): string {
  const plain = [...fileName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code < 0x7f && !UNSAFE_IN_PLAIN.includes(character) ? character : '_';
    })
    .join('');
  const exact = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}"; filename*=UTF-8''${exact}`;
}
