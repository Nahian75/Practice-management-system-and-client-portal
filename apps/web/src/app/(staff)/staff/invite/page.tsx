import type { Metadata } from 'next';
import Link from 'next/link';
import { HowTo } from '@/components/how-to';
import { InviteForm } from './invite-form';

export const metadata: Metadata = { title: 'Invite someone' };

export default function InvitePage() {
  return (
    <>
      <p>
        <Link href="/staff">Back to staff</Link>
      </p>
      <h1>Invite someone</h1>
      <HowTo>
        <li>Enter their name and work email address, then send the invitation.</li>
        <li>They set their own password and authenticator from the emailed link.</li>
        <li>Then open their name on the Staff page and give them the roles they need.</li>
      </HowTo>
      <p>
        They are emailed a link, valid for a limited time, to set a password and an authenticator. Inviting someone already
        invited sends a fresh link and cancels the old one. You give them their roles next.
      </p>
      <InviteForm />
    </>
  );
}
