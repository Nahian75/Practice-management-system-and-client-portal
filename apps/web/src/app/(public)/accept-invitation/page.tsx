import type { Metadata } from 'next';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = { title: 'Set up your account' };

export default function AcceptInvitationPage() {
  return (
    <>
      <h1>Set up your account</h1>
      <AcceptInvitation />
    </>
  );
}
