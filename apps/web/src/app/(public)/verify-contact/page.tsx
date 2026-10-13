import type { Metadata } from 'next';
import { VerifyContact } from './verify-contact';

export const metadata: Metadata = { title: 'Verify email address' };

export default function VerifyContactPage() {
  return <><h1>Verify email address</h1><VerifyContact /></>;
}
