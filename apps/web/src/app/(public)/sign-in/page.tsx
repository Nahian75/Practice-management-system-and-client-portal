import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentAccount } from '@/lib/api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  if ((await currentAccount())?.kind === 'staff') {
    redirect('/');
  }

  return (
    <>
      <h1>Sign in</h1>
      <SignInForm />
    </>
  );
}
