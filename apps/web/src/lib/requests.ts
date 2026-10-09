/**
 * Sends JSON to the API through this site's `/api/...` pass-through, from
 * the browser. The session cookie goes with it automatically; nothing else
 * about the person is added here.
 */
export function postJson(path: `/api/${string}`, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function putJson(path: `/api/${string}`, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * What the API said about a refused request, as a list: one message, or
 * several (a refused password gives every reason). A general message when
 * the answer has none.
 */
export async function messagesOf(response: Response): Promise<string[]> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') {
      return [body.message];
    }
    if (Array.isArray(body.message) && body.message.every((message) => typeof message === 'string')) {
      return body.message as string[];
    }
  } catch {
    // Not JSON: fall through to the general message.
  }
  return [response.status === 429 ? 'Too many attempts. Try again later' : 'Something went wrong. Try again'];
}

/**
 * The token from a link's fragment (`#token=...`), then removed from the
 * address bar and history. The fragment never reaches any server, and
 * removing it keeps the token out of bookmarks and screenshots.
 */
export function takeTokenFromAddress(): string | undefined {
  const token = /^#token=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1];
  window.history.replaceState(null, '', window.location.pathname);
  return token;
}
