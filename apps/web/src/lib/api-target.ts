import { apiOrigin } from '../config';

export const API_PREFIX = '/api/';

/**
 * The API address for a request to `/api/...`. The path is set on a fixed URL
 * rather than joined as text: "/api//evil.example/x" would otherwise read as
 * a protocol-relative address and be sent to another server.
 */
export function apiTarget(url: URL): URL {
  const target = new URL(apiOrigin());
  target.pathname = url.pathname.slice(API_PREFIX.length - 1);
  target.search = url.search;
  return target;
}
