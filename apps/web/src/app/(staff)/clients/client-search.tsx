'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { ClientSummary } from '@/lib/clients';
import { CLIENT_KIND_LABELS } from '@/lib/format';
import { messagesOf } from '@/lib/requests';

/**
 * Finds any client in the firm by name or reference, to avoid creating one
 * twice. Sent from the browser through /api, so the audit record of each
 * search carries the searcher's own address. Each search counts towards the
 * hourly allowance, which the API enforces.
 */
export function ClientSearch() {
  const [results, setResults] = useState<{ text: string; clients: ClientSummary[] }>();
  const [errors, setErrors] = useState<string[]>();
  const [searching, setSearching] = useState(false);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('q')).trim();
    setSearching(true);
    setErrors(undefined);
    try {
      const response = await fetch(`/api/clients/search?${new URLSearchParams({ q: text })}`);
      if (response.ok) {
        const { clients } = (await response.json()) as { clients: ClientSummary[] };
        setResults({ text, clients });
      } else {
        setResults(undefined);
        setErrors(response.status === 400 ? ['Enter at least 2 characters'] : await messagesOf(response));
      }
    } finally {
      setSearching(false);
    }
  }

  return (
    <section aria-labelledby="search-heading">
      <h2 id="search-heading">Find a client</h2>
      <form onSubmit={search} role="search" noValidate>
        {errors && <ErrorSummary messages={errors} />}
        <div className="field">
          <label className="label" htmlFor="q">
            Name or reference
          </label>
          <span className="hint" id="q-hint">
            Searches every client of the firm. You see only the reference, type and name of clients you are not
            responsible for.
          </span>
          <input className="input" id="q" name="q" type="search" autoComplete="off" spellCheck={false} aria-describedby="q-hint" />
        </div>
        <button className="button button-secondary" type="submit" disabled={searching}>
          Search
        </button>
      </form>

      {results && (
        <div aria-live="polite">
          {results.clients.length === 0 ? (
            <p>No clients match “{results.text}”.</p>
          ) : (
            <table className="table">
              <caption>
                {results.clients.length === 20 ? 'The first 20 clients' : `${results.clients.length} clients`} matching “
                {results.text}”
              </caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                </tr>
              </thead>
              <tbody>
                {results.clients.map((client) => (
                  <tr key={client.id}>
                    <td>{client.reference}</td>
                    <td>
                      <Link href={`/clients/${client.id}`}>{client.name}</Link>
                    </td>
                    <td>{CLIENT_KIND_LABELS[client.kind]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
