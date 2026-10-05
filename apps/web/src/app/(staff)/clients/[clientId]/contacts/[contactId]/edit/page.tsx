import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { clientName, type Client } from '@/lib/clients';
import { ContactForm } from '../../contact-form';

export const metadata: Metadata = { title: 'Change a contact' };

export default async function EditContactPage({ params }: { params: Promise<{ clientId: string; contactId: string }> }) {
  const { clientId, contactId } = await params;
  const { status, body: client } = await apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`);
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  // The contact is found in this client's own list, so another client's contact cannot be opened here.
  const contact = client?.kind === 'organisation' ? client.contacts.find((candidate) => candidate.id === contactId) : undefined;
  if (!client || !contact) {
    notFound();
  }

  return (
    <>
      <p>
        <Link href={`/clients/${client.id}`}>Back to {clientName(client)}</Link>
      </p>
      <span className="caption">{client.reference}</span>
      <h1>
        Change {contact.givenNames} {contact.familyName}
      </h1>
      <ContactForm clientId={client.id} contact={contact} />
    </>
  );
}
