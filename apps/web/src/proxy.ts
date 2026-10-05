import { NextResponse, type NextRequest } from 'next/server';
import { API_PREFIX, apiTarget } from './lib/api-target';

/**
 * Runs before every request (Next.js "proxy").
 *
 * `/api/...` is passed to the API unchanged, cookies and all, so the browser
 * only ever talks to this address: the session cookie stays on one site and
 * the API's CSRF check sees same-site requests.
 *
 * Every page gets a fresh nonce and a strict Content Security Policy.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith(API_PREFIX)) {
    return NextResponse.rewrite(apiTarget(request.nextUrl));
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const policy = contentSecurityPolicy(nonce);

  // Next.js reads the nonce from the request's policy and puts it on its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', policy);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(securityHeaders(policy))) {
    response.headers.set(name, value);
  }
  return response;
}

export function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    // React needs eval only in development, for its error overlay.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function securityHeaders(policy: string): Record<string, string> {
  return {
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

export const config = {
  // Static files need no policy; everything else, pages and /api, comes through here.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
