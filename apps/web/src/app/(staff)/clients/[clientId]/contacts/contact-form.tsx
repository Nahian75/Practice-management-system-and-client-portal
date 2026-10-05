'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { TextField, optionalText } from '@/components/fields';
import type { Contact } from '@/lib/clients';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * Adding a contact to an organisation client, or changing one. A contact who
 * leaves is marked as no longer a contact, never deleted, so past
 * correspondence still says who it was with.
 */
export function ContactForm({ clientId, contact }: { clientId: string; contact?: Contact }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const details = {
      givenNames: String(form.get('givenNames') ?? '').trim(),
      familyName: String(form.get('familyName') ?? '').trim(),
      jobTitle: optionalText(form, 'jobTitle'),
      email: optionalText(form, 'email'),
      phone: optionalText(form, 'phone'),
    };
    const path = `/api/clients/${encodeURIComponent(clientId)}/contacts` as const;

    setSending(true);
    setErrors(undefined);
    try {
      const response = contact
        ? await fetch(`${path}/${contact.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...details, active: form.get('inactive') !== 'yes' }),
          })
        : await postJson(path, details);
      if (response.ok) {
        router.push(`/clients/${clientId}`);
        router.refresh();
        return;
      }
      setErrors(response.status === 400 ? ['Check the details: given names and family name are required'] : await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <TextField name="givenNames" label="Given names" defaultValue={contact?.givenNames} />
      <TextField name="familyName" label="Family name" defaultValue={contact?.familyName} />
      <TextField name="jobTitle" label="Job title (optional)" defaultValue={contact?.jobTitle} />
      <TextField name="email" label="Email (optional)" type="email" defaultValue={contact?.email} />
      <TextField name="phone" label="Phone (optional)" type="tel" defaultValue={contact?.phone} />
      {contact && (
        <div className="field checkbox">
          <label>
            <input type="checkbox" name="inactive" value="yes" defaultChecked={!contact.active} />
            No longer a contact, for example because they have left the organisation
          </label>
        </div>
      )}
      <button className="button" type="submit" disabled={sending}>
        {contact ? 'Save changes' : 'Add contact'}
      </button>
    </form>
  );
}
