import type { Request, Response } from 'express';
import { SESSION_TOKEN_PATTERN } from './session-token.js';

export const SESSION_COOKIE = '__Host-session';

// __Host- requires Secure and Path=/ with no Domain, so no subdomain can set or
// overwrite it. No Max-Age: the browser drops it when closed, and the server
// enforces the real limits.
const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax';

/**
 * Returns the session token, or undefined when the cookie is absent, sent more
 * than once, or not in the token format. Nothing else in the Cookie header is read.
 */
export function readSessionToken(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }

  const values = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    .map((pair) => pair.slice(SESSION_COOKIE.length + 1));

  const [token] = values;
  return values.length === 1 && token !== undefined && SESSION_TOKEN_PATTERN.test(token) ? token : undefined;
}

export function setSessionCookie(response: Response, token: string): void {
  response.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}`);
}

export function clearSessionCookie(response: Response): void {
  response.append('Set-Cookie', `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`);
}
