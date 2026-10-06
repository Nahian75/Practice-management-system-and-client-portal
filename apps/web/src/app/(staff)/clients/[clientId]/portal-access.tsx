'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { formatDate } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

export interface PortalPerson {
  id: string;
  contactId: string | null;
  name: string;
  email: string;
  accountStatus: 'invited' | 'active' | 'disabled';
  linkedAt: string;
}

/** Someone on the client's record who could be given a login: the individual client, or one current contact. */
export interface PortalCandidate {
  contactId: string | null;
  name: string;
  email: string | null;
}

const STATUS = { invited: 'Invited, not yet set up', active: 'Using the portal', disabled: 'Account disabled' } as const;

/**
 * Who can see this client in the portal, and the buttons to invite the people
 * on its record and to end access. Invitations go only to the address on
 * record, so that address is shown beside each button.
 */
export function PortalAccess({ clientId, people, candidates }: { clientId: string; people: PortalPerson[]; candidates: PortalCandidate[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [done, setDone] = useState<string>();
  const [sending, setSending] = useState(false);
  const path = `/api/clients/${encodeURIComponent(clientId)}/portal-access` as const;

  async function send(request: () => Promise<Response>, success: string) {
    setSending(true);
    setErrors(undefined);
    setDone(undefined);
    try {
      const response = await request();
      if (response.ok) {
        setDone(success);
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  const linked = new Set(people.map((person) => person.contactId ?? 'client'));
  const invitable = candidates.filter((candidate) => !linked.has(candidate.contactId ?? 'client'));

  return (
    <section aria-labelledby="portal-heading">
      <h2 id="portal-heading">Portal access</h2>
      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{done && <p className="notice">{done}</p>}</div>

      {people.length === 0 ? (
        <p>Nobody can see this client in the portal yet.</p>
      ) : (
        <table className="table">
          <caption className="secondary">They see this client&rsquo;s matters, and only documents shared with the client.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Status</th>
              <th scope="col">Since</th>
              <th scope="col">
                <span className="visually-hidden">End access</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id}>
                <td>{person.name}</td>
                <td>{person.email}</td>
                <td>{STATUS[person.accountStatus]}</td>
                <td>{formatDate(person.linkedAt)}</td>
                <td>
                  <button
                    className="link-button"
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      void send(
                        () => fetch(`${path}/${encodeURIComponent(person.id)}`, { method: 'DELETE' }),
                        `${person.name} can no longer see this client in the portal.`,
                      )
                    }
                  >
                    End access<span className="visually-hidden"> for {person.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {invitable.length > 0 && (
        <ul className="plain-list">
          {invitable.map((candidate) => (
            <li key={candidate.contactId ?? 'client'}>
              {candidate.email ? (
                <>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      void send(
                        () => postJson(path, candidate.contactId ? { contactId: candidate.contactId } : {}),
                        `${candidate.name} has been given access. If they are new to the portal, an invitation has gone to ${candidate.email}.`,
                      )
                    }
                  >
                    Invite {candidate.name} to the portal
                  </button>{' '}
                  <span className="secondary">The invitation goes to {candidate.email}, the address on record.</span>
                </>
              ) : (
                <span>
                  {candidate.name} has no email address on record.{' '}
                  {candidate.contactId === null ? (
                    <Link href={`/clients/${clientId}/edit`}>Add one to invite them</Link>
                  ) : (
                    <Link href={`/clients/${clientId}/contacts/${candidate.contactId}/edit`}>Add one to invite them</Link>
                  )}
                  .
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
