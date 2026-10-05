import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { clientName, type Client } from '@/lib/clients';
import type { Colleague } from '@/lib/matters';
import { OpenMatterFlow } from './open-matter-flow';

export const metadata: Metadata = { title: 'Open a matter' };

export default async function OpenMatterPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const colleagues = await apiGet<{ colleagues: Colleague[] }>('/colleagues');
  if (colleagues.status === 403) {
    return <NoAccess what="opening matters" />;
  }
  const { status, body: client } = await apiGet<Client>(`/clients/${encodeURIComponent(clientId)}`);
  if (status === 403) {
    return <NoAccess what="clients" />;
  }
  if (!client || !colleagues.body) {
    notFound();
  }
  const hasPartner = colleagues.body.colleagues.some((colleague) => colleague.isPartner);

  return (
    <>
      <p>
        <Link href={`/clients/${client.id}`}>Back to {clientName(client)}</Link>
      </p>
      <span className="caption">{client.reference}</span>
      <h1>Open a matter</h1>
      {hasPartner ? (
        <OpenMatterFlow
          clientId={client.id}
          clientCheckName={client.kind === 'organisation' ? client.legalName : `${client.givenNames} ${client.familyName}`}
          colleagues={colleagues.body.colleagues}
          accountId={account.id}
        />
      ) : (
        <p>Every matter needs a supervising partner, and the firm has no active partner. Ask an administrator.</p>
      )}
    </>
  );
}
