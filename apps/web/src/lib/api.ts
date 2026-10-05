import { cookies } from 'next/headers';
import { apiOrigin } from '@/config';

const SESSION_COOKIE = '__Host-session';

export interface SignedInAccount {
  id: string;
  kind: 'staff' | 'client';
  displayName: string;
}

/**
 * Reads from the API on the server, as the visitor: only their session cookie
 * is passed on, nothing else from the browser. The answer is never cached.
 * `path` comes from this app's code, never from the visitor.
 */
export async function apiGet<T>(
  path: `/${string}`,
  query: Record<string, string | undefined> = {},
): Promise<{ status: number; body: T | undefined }> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const url = new URL(apiOrigin());
  url.pathname = path;
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }

  const response = await fetch(url, {
    headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
    cache: 'no-store',
  });
  const body = response.ok ? ((await response.json()) as T) : undefined;
  return { status: response.status, body };
}

/** The signed-in account, or undefined when there is no valid session. */
export async function currentAccount(): Promise<SignedInAccount | undefined> {
  const { status, body } = await apiGet<{ account: SignedInAccount }>('/auth/session');
  return status === 200 ? body?.account : undefined;
}
