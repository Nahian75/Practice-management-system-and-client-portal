'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { AddressFields, DateFields, TextField, addressFrom, dateFrom, optionalText } from '@/components/fields';
import type { Client } from '@/lib/clients';
import { ORGANISATION_TYPE_LABELS } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

type Kind = Client['kind'];

/**
 * Creating a client, or changing one's details. The kind is chosen once, when
 * the client is created, and never changes. Every field is sent; an emptied
 * optional field is sent as null, which the API reads as "none".
 */
export function ClientForm({ client }: { client?: Client }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(client?.kind ?? 'individual');
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const shared = { email: optionalText(form, 'email'), phone: optionalText(form, 'phone'), address: addressFrom(form) };
    const details =
      kind === 'individual'
        ? {
            kind,
            title: optionalText(form, 'title'),
            givenNames: text('givenNames'),
            familyName: text('familyName'),
            dateOfBirth: dateFrom(form, 'dateOfBirth'),
            ...shared,
          }
        : {
            kind,
            legalName: text('legalName'),
            organisationType: text('organisationType'),
            registrationNumber: optionalText(form, 'registrationNumber'),
            ...shared,
          };

    setSending(true);
    setErrors(undefined);
    try {
      const response = client
        ? await fetch(`/api/clients/${client.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(details),
          })
        : await postJson('/api/clients', details);
      if (response.ok) {
        const id = client?.id ?? ((await response.json()) as { id: string }).id;
        router.push(`/clients/${id}`);
        router.refresh();
        return;
      }
      setErrors(
        response.status === 400
          ? ['Check the details: names are required, an address needs a first line, a town and a country, and dates must be real']
          : await messagesOf(response),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      {errors && <ErrorSummary messages={errors} />}

      {!client && (
        <fieldset className="fieldset radios">
          <legend>Is the client a person or an organisation?</legend>
          {(['individual', 'organisation'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
              {value === 'individual' ? 'A person' : 'An organisation, such as a company, charity or trust'}
            </label>
          ))}
        </fieldset>
      )}

      {kind === 'individual' ? (
        <>
          <TextField name="title" label="Title (optional)" hint="For example Mr, Ms, Dr" width="short" defaultValue={client?.kind === 'individual' ? client.title : null} />
          <TextField name="givenNames" label="Given names" autoComplete="given-name" defaultValue={client?.kind === 'individual' ? client.givenNames : null} />
          <TextField name="familyName" label="Family name" autoComplete="family-name" defaultValue={client?.kind === 'individual' ? client.familyName : null} />
          <DateFields
            name="dateOfBirth"
            legend="Date of birth (optional)"
            hint="For example 27 3 1980"
            value={client?.kind === 'individual' ? client.dateOfBirth : null}
          />
        </>
      ) : (
        <>
          <TextField name="legalName" label="Legal name" hint="As registered, for example Acme Trading Ltd" defaultValue={client?.kind === 'organisation' ? client.legalName : null} />
          <div className="field">
            <label className="label" htmlFor="organisationType">
              Type of organisation
            </label>
            <select
              className="select"
              id="organisationType"
              name="organisationType"
              defaultValue={client?.kind === 'organisation' ? client.organisationType : 'company'}
            >
              {Object.entries(ORGANISATION_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <TextField
            name="registrationNumber"
            label="Registration number (optional)"
            hint="For example the Companies House or Charity Commission number"
            width="short"
            defaultValue={client?.kind === 'organisation' ? client.registrationNumber : null}
          />
        </>
      )}

      <TextField name="email" label="Email (optional)" type="email" defaultValue={client?.email} />
      <TextField name="phone" label="Phone (optional)" type="tel" defaultValue={client?.phone} />
      <AddressFields legend={kind === 'individual' ? 'Address' : 'Registered address'} value={client?.address} />

      <button className="button" type="submit" disabled={sending}>
        {client ? 'Save changes' : 'Create client'}
      </button>
    </form>
  );
}
