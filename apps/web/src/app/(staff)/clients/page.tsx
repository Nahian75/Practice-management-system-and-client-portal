import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import type { ClientSummary } from '@/lib/clients';
import { CLIENT_KIND_LABELS } from '@/lib/format';
import { ClientSearch } from './client-search';

export const metadata: Metadata = { title: 'Clients' };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const { status, body } = await apiGet<{ clients: ClientSummary[]; next: string | null }>('/clients', {
    before: typeof before === 'string' ? before : undefined,
  });
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  if (status === 400) {
    // A page marker that is not a client reference: start from the newest.
    redirect('/clients');
  }

  const clients = body?.clients ?? [];
  return (
    <>
      <h1>Clients</h1>
      <div className="actions">
        <Link className="button" href="/clients/new">
          Create a client
        </Link>
      </div>

      <ClientSearch />

      <hr className="rule" />
      <h2>Your clients</h2>
      {clients.length === 0 ? (
        <p>You are not responsible for any clients yet, and you are on no matter team.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first. Only clients you are responsible for, or on a matter team for, appear here.</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
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
      {body?.next && (
        <p>
          <Link href={`/clients?before=${encodeURIComponent(body.next)}`}>Older clients</Link>
        </p>
      )}
    </>
  );
}
