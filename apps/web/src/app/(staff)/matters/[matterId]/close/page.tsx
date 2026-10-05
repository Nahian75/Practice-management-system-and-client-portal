import type { Metadata } from 'next';
import Link from 'next/link';
import { matterToChange } from '../matter-page-data';
import { CloseForm } from './close-form';

export const metadata: Metadata = { title: 'Close a matter' };

export default async function CloseMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matter, isSupervisor } = await matterToChange((await params).matterId);

  return (
    <>
      <p>
        <Link href={`/matters/${matter.id}`}>Back to the matter</Link>
      </p>
      <span className="caption">{matter.reference}</span>
      <h1>Close {matter.title}</h1>
      {isSupervisor ? (
        <>
          <p>Closing is final. Nobody can change the matter or its team afterwards; it stays readable for its team.</p>
          <CloseForm matterId={matter.id} />
        </>
      ) : (
        <p>Only the matter&rsquo;s supervising partner can close it.</p>
      )}
    </>
  );
}
