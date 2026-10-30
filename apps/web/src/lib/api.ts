import { isIP } from 'node:net';
import { cookies, headers } from 'next/headers';
import { apiOrigin } from '@/config';

const SESSION_COOKIE = '__Host-session';

export interface SignedInAccount {
  id: string;
  kind: 'staff' | 'client';
  displayName: string;
}

/**
 * Reads from the API on the server, as the visitor: only their session cookie
 * and validated proxy address chain are passed on. The API only believes the
 * chain from its configured trusted peers. The web server must remain private
 * behind the edge, which replaces untrusted client forwarding headers.
 * The answer is never cached.
 * `path` comes from this app's code, never from the visitor.
 */
export async function apiGet<T>(
  path: `/${string}`,
  query: Record<string, string | undefined> = {},
): Promise<{ status: number; body: T | undefined }> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const forwarded = (await headers()).get('x-forwarded-for');
  const addresses = forwarded?.split(',').map(value => value.trim());
  const requestHeaders: Record<string,string> = session ? {cookie:`${SESSION_COOKIE}=${session}`} : {};
  if (addresses?.length && addresses.length <= 16 && addresses.every(address => isIP(address) !== 0)) {
    requestHeaders['x-forwarded-for'] = addresses.join(', ');
  }
  const url = new URL(apiOrigin());
  url.pathname = path;
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }

  const response = await fetch(url, {
    headers: requestHeaders,
    cache: 'no-store',
  });
  // Unavailable reads must not become empty financial/client lists or a false
  // sign-out. The existing error boundary shows a safe retry page.
  if (response.status === 429 || response.status >= 500) {
    throw new Error('The service is temporarily unavailable');
  }
  const body = response.ok ? ((await response.json()) as T) : undefined;
  return { status: response.status, body };
}

/** The signed-in account, or undefined when there is no valid session. */
export async function currentAccount(): Promise<SignedInAccount | undefined> {
  const { status, body } = await apiGet<{ account: SignedInAccount }>('/auth/session');
  return status === 200 ? body?.account : undefined;
}
