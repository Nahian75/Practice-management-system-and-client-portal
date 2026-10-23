import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentAccount } from '@/lib/api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const account = await currentAccount();
  if (account) {
    redirect(account.kind === 'client' ? '/portal' : '/');
  }

  return (
    <>
      <span className="caption">Secure account access</span>
      <h1>Sign in</h1>
      <p className="secondary">Access your practice workspace or client portal.</p>
      <SignInForm />
    </>
  );
}
