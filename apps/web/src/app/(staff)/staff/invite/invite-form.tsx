'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { TextField } from '@/components/fields';
import { postJson } from '@/lib/requests';
import { staffChangeRefusal } from '../staff-requests';

/**
 * Inviting a staff member: the API emails them a link to set a password and
 * an authenticator. Roles are given afterwards, on their page, one at a time,
 * so a role that is refused never leaves the others half done.
 */
export function InviteForm() {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const displayName = String(form.get('displayName') ?? '').trim();
    const problems = [
      ...(displayName === '' ? ['Enter their name'] : []),
      ...(/^[^@\s]+@[^@\s]+$/.test(email) ? [] : ['Enter their email address, such as name@example.com']),
    ];
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/staff/invitations', { email, displayName });
      if (response.ok) {
        const { accountId } = (await response.json()) as { accountId: string };
        router.push(`/staff/${accountId}?invited=1`);
        return;
      }
      setErrors(response.status === 400 ? ['Check the email address and name'] : await staffChangeRefusal(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={invite} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <TextField name="displayName" label="Name" hint="As colleagues will see it, for example Jane Smith" />
      <TextField name="email" label="Email address" type="email" hint="Their work address. The invitation link goes here." />
      <button className="button" type="submit" disabled={sending}>
        Send invitation
      </button>
    </form>
  );
}
