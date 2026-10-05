'use client';

import qrcode from 'qrcode-generator';

/**
 * A QR code drawn as SVG squares in the page itself: the text it holds (an
 * authenticator set-up link, with its secret) is never sent anywhere to be
 * turned into an image.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();

  const size = code.getModuleCount();
  const quiet = 4;
  const squares: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (code.isDark(row, column)) {
        squares.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size + quiet * 2} ${size + quiet * 2}`}
      width="200"
      height="200"
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#ffffff" />
      <path d={squares.join('')} fill="#000000" />
    </svg>
  );
}
