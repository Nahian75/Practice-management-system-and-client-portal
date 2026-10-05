import type { Metadata } from 'next';
import Link from 'next/link';
import { matterToChange } from '../matter-page-data';
import { MatterForm } from './matter-form';

export const metadata: Metadata = { title: 'Change a matter' };

export default async function EditMatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matter } = await matterToChange((await params).matterId);

  return (
    <>
      <p>
        <Link href={`/matters/${matter.id}`}>Back to the matter</Link>
      </p>
      <span className="caption">{matter.reference}</span>
      <h1>Change details</h1>
      <MatterForm matter={matter} />
    </>
  );
}
