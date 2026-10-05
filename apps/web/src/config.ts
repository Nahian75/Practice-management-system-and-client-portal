/**
 * Server-side settings, read from the environment when the app runs. None of
 * them reach the browser: they are never prefixed NEXT_PUBLIC_.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set (see apps/web/.env.example)`);
  }
  return value;
}

/** Where the web app reaches the API. Only the origin is used; any path in it is ignored. */
export function apiOrigin(): string {
  return new URL(required('API_URL')).origin;
}

export function appName(): string {
  return required('APP_NAME');
}
