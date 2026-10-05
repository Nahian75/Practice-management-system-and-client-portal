import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { clientName, type Client } from '@/lib/clients';
import { ContactForm } from '../contact-form';

export const metadata: Metadata = { title: 'Add a contact' };

export default async function NewContactPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const { status, body: client } = await apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`);
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  if (!client || client.kind !== 'organisation') {
    notFound();
  }

  return (
    <>
      <p>
        <Link href={`/clients/${client.id}`}>Back to {clientName(client)}</Link>
      </p>
      <span className="caption">{client.reference}</span>
      <h1>Add a contact</h1>
      <ContactForm clientId={client.id} />
    </>
  );
}
