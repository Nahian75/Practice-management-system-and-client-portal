import type { Metadata } from 'next';
import Link from 'next/link';
import { InviteForm } from './invite-form';

export const metadata: Metadata = { title: 'Invite someone' };

export default function InvitePage() {
  return (
    <>
      <p>
        <Link href="/staff">Back to staff</Link>
      </p>
      <h1>Invite someone</h1>
      <p>
        They are emailed a link, valid for a limited time, to set a password and an authenticator. Inviting someone already
        invited sends a fresh link and cancels the old one. You give them their roles next.
      </p>
      <InviteForm />
    </>
  );
}
