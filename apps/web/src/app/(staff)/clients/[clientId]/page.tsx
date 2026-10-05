import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { clientName, type Client } from '@/lib/clients';
import { CLIENT_KIND_LABELS, countryName, formatCalendarDate, formatDate, ORGANISATION_TYPE_LABELS } from '@/lib/format';
import { MATTER_STATUS_LABELS, type MatterSummary } from '@/lib/matters';
import { TakeOverForm } from './take-over-form';

export const metadata: Metadata = { title: 'Client' };

export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const { status, body: client } = await apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`);
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  if (status === 400) {
    notFound();
  }
  if (status === 404 || !client) {
    // The API gives the same answer for a client that does not exist and one
    // the person may not see; so does this page.
    return (
      <>
        <h1>You cannot see this client</h1>
        <p>Either there is no such client, or you are not responsible for it and are on none of its matter teams.</p>
        <hr className="rule" />
        <TakeOverForm clientId={clientId} />
      </>
    );
  }

  const matters = await apiGet<{ matters: MatterSummary[] }>(`/clients/${encodeURIComponent(clientId)}/matters`);
  const rows: [string, string | null][] =
    client.kind === 'individual'
      ? [
          ['Title', client.title],
          ['Given names', client.givenNames],
          ['Family name', client.familyName],
          ['Date of birth', client.dateOfBirth && formatCalendarDate(client.dateOfBirth)],
        ]
      : [
          ['Legal name', client.legalName],
          ['Type of organisation', ORGANISATION_TYPE_LABELS[client.organisationType]],
          ['Registration number', client.registrationNumber],
        ];
  const address = client.address
    ? [client.address.line1, client.address.line2, client.address.town, client.address.postcode, countryName(client.address.country)]
        .filter(Boolean)
        .join(', ')
    : null;

  return (
    <>
      <span className="caption">
        {client.reference} · {CLIENT_KIND_LABELS[client.kind]}
      </span>
      <h1>{clientName(client)}</h1>
      <div className="actions">
        <Link href={`/clients/${client.id}/edit`}>Change details</Link>
        {client.kind === 'organisation' && <Link href={`/clients/${client.id}/contacts/new`}>Add a contact</Link>}
        <Link href={`/clients/${client.id}/matters/new`}>Open a matter</Link>
      </div>

      <dl className="summary">
        {[...rows, ['Email', client.email], ['Phone', client.phone], ['Address', address], ['Client since', formatDate(client.createdAt)]].map(
          ([label, value]) => (
            <div key={label} className="summary-row">
              <dt>{label}</dt>
              <dd>{value ?? <span className="secondary">Not given</span>}</dd>
            </div>
          ),
        )}
      </dl>

      {client.kind === 'organisation' && (
        <>
          <h2>Contacts</h2>
          {client.contacts.length === 0 ? (
            <p>No contacts yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Job title</th>
                  <th scope="col">Email</th>
                  <th scope="col">Phone</th>
                  <th scope="col">
                    <span className="visually-hidden">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {client.contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      {contact.givenNames} {contact.familyName}
                      {!contact.active && <span className="secondary"> (no longer a contact)</span>}
                    </td>
                    <td>{contact.jobTitle}</td>
                    <td>{contact.email}</td>
                    <td>{contact.phone}</td>
                    <td>
                      <Link href={`/clients/${client.id}/contacts/${contact.id}/edit`}>
                        Change<span className="visually-hidden">
                          {' '}
                          {contact.givenNames} {contact.familyName}
                        </span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h2>Matters</h2>
      {matters.status !== 200 || !matters.body || matters.body.matters.length === 0 ? (
        <p>No matters you are on the team of.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {matters.body.matters.map((matter) => (
              <tr key={matter.id}>
                <td>{matter.reference}</td>
                <td>
                  <Link href={`/matters/${matter.id}`}>{matter.title}</Link>
                </td>
                <td>{MATTER_STATUS_LABELS[matter.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
