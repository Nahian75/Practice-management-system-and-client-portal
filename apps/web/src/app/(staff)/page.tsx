import type { Metadata } from 'next';
import { currentAccount } from '@/lib/api';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const account = await currentAccount();

  return (
    <>
      <h1>Home</h1>
      <p>You are signed in as {account?.displayName}.</p>
      <hr className="rule" />
      <p className="secondary">Clients and matters will appear here.</p>
    </>
  );
}
