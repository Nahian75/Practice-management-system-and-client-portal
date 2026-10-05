import type { Metadata } from 'next';
import Link from 'next/link';
import { ClientForm } from '../client-form';

export const metadata: Metadata = { title: 'Create a client' };

export default function NewClientPage() {
  return (
    <>
      <p>
        <Link href="/clients">Back to clients</Link>
      </p>
      <h1>Create a client</h1>
      <p>Search for the client first, so the same person or organisation is not created twice.</p>
      <ClientForm />
    </>
  );
}
