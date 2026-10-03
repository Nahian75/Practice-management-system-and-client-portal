import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { clearSessionCookie, readSessionToken, setSessionCookie } from './session-cookie.js';
import { generateOpaqueToken } from '../../common/crypto/opaque-token.js';

const TOKEN = generateOpaqueToken();

const requestWithCookie = (cookie: string | undefined) => ({ headers: { cookie } }) as Request;

function capturedSetCookie(write: (response: Response) => void): string {
  const append = vi.fn();
  write({ append } as unknown as Response);
  expect(append).toHaveBeenCalledWith('Set-Cookie', expect.any(String));
  return append.mock.calls[0]?.[1] as string;
}

describe('readSessionToken', () => {
  it('reads the session cookie', () => {
    expect(readSessionToken(requestWithCookie(`__Host-session=${TOKEN}`))).toBe(TOKEN);
  });

  it('finds it among other cookies', () => {
    expect(readSessionToken(requestWithCookie(`theme=dark; __Host-session=${TOKEN}; lang=en`))).toBe(TOKEN);
  });

  it.each([
    ['no Cookie header', undefined],
    ['an empty header', ''],
    ['only other cookies', 'theme=dark'],
    ['a cookie without the __Host- prefix', `session=${TOKEN}`],
    ['a name that merely ends with the cookie name', `x__Host-session=${TOKEN}`],
    ['a value in the wrong format', '__Host-session=not-a-token'],
    ['a value too short', `__Host-session=${TOKEN.slice(1)}`],
    ['a value with injected attributes', `__Host-session=${TOKEN}%3B%20Path%3D%2F`],
    ['the cookie sent twice', `__Host-session=${TOKEN}; __Host-session=${generateOpaqueToken()}`],
  ])('returns nothing for %s', (_case, header) => {
    expect(readSessionToken(requestWithCookie(header))).toBeUndefined();
  });
});

describe('setSessionCookie', () => {
  it('sets every protective attribute and no lifetime', () => {
    const header = capturedSetCookie((response) => setSessionCookie(response, TOKEN));

    expect(header).toBe(`__Host-session=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  });
});

describe('clearSessionCookie', () => {
  it('expires the cookie with the same attributes it was set with', () => {
    const header = capturedSetCookie(clearSessionCookie);

    expect(header).toBe('__Host-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  });
});
