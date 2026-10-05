'use client';

/**
 * Shown when a page fails, for example because the API cannot be reached.
 * Only Next.js's reference for the error is shown: the error itself, which
 * may name servers or carry data, stays in the server's log, where the
 * reference finds it (review W4).
 */
export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <main id="main" className="main">
      <h1>Sorry, there is a problem with the service</h1>
      <p>Try again in a few minutes. Anything you were entering may not have been saved.</p>
      {error.digest && (
        <p>
          If it keeps happening, give this reference to whoever supports the system: <code className="secret">{error.digest}</code>
        </p>
      )}
      <p>
        <button className="button button-secondary" type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </p>
    </main>
  );
}
