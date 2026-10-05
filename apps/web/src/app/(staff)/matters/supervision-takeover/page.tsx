import type { Metadata } from 'next';
import Link from 'next/link';
import { TakeoverForm } from './takeover-form';

export const metadata: Metadata = { title: 'Take over supervision' };

export default function SupervisionTakeoverPage() {
  return (
    <>
      <p>
        <Link href="/matters">Back to matters</Link>
      </p>
      <h1>Take over supervision of a matter</h1>
      <p>
        For partners. Possible only when the matter&rsquo;s supervising partner can no longer act: they have left the firm,
        or no longer hold the partner role. Otherwise ask them to hand over.
      </p>
      <TakeoverForm />
    </>
  );
}
