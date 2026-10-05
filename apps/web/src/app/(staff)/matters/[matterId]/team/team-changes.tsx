'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { TEAM_ROLE_LABELS, type Colleague, type Matter } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

/**
 * The supervising partner's changes to the team: adding and removing fee
 * earners, and handing supervision to another partner. Someone removed loses
 * access to the matter at once.
 */
export function TeamChanges({ matter, colleagues, accountId }: { matter: Matter; colleagues: Colleague[]; accountId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  const teamPath = `/api/matters/${encodeURIComponent(matter.id)}/team`;
  const onTeam = new Set(matter.team.map((member) => member.accountId));
  const canJoin = colleagues.filter((colleague) => !onTeam.has(colleague.id));
  const otherPartners = colleagues.filter((colleague) => colleague.isPartner && colleague.id !== accountId);

  async function send(change: () => Promise<Response>, afterwards: () => void) {
    setSending(true);
    setErrors(undefined);
    try {
      const response = await change();
      if (response.ok) {
        afterwards();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get('accountId'));
    void send(() => fetch(`${teamPath}/${encodeURIComponent(id)}`, { method: 'PUT' }), () => router.refresh());
  }

  function handOver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get('partnerId'));
    // Afterwards this person is a fee earner on the matter, so this page is no longer theirs.
    void send(
      () => postJson(`/api/matters/${encodeURIComponent(matter.id)}/supervisor`, { accountId: id }),
      () => {
        router.push(`/matters/${matter.id}`);
        router.refresh();
      },
    );
  }

  return (
    <>
      {errors && <ErrorSummary messages={errors} />}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">
              <span className="visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {matter.team.map((member) => (
            <tr key={member.accountId}>
              <td>{member.displayName}</td>
              <td>{TEAM_ROLE_LABELS[member.role]}</td>
              <td>
                {member.role === 'fee_earner' && (
                  <button
                    className="link-button"
                    type="button"
                    disabled={sending}
                    onClick={() =>
                      void send(() => fetch(`${teamPath}/${encodeURIComponent(member.accountId)}`, { method: 'DELETE' }), () => router.refresh())
                    }
                  >
                    Remove<span className="visually-hidden"> {member.displayName}</span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add a fee earner</h2>
      {canJoin.length === 0 ? (
        <p>Everyone who can work on matters is already on the team.</p>
      ) : (
        <form onSubmit={add} noValidate>
          <div className="field">
            <label className="label" htmlFor="accountId">
              Colleague
            </label>
            <select className="select" id="accountId" name="accountId">
              {canJoin.map((colleague) => (
                <option key={colleague.id} value={colleague.id}>
                  {colleague.displayName}
                </option>
              ))}
            </select>
          </div>
          <button className="button button-secondary" type="submit" disabled={sending}>
            Add to the team
          </button>
        </form>
      )}

      <h2>Hand over supervision</h2>
      {otherPartners.length === 0 ? (
        <p>There is no other active partner to hand over to.</p>
      ) : (
        <form onSubmit={handOver} noValidate>
          <p>The partner you choose becomes the supervising partner. You stay on the team as a fee earner.</p>
          <div className="field">
            <label className="label" htmlFor="partnerId">
              Partner
            </label>
            <select className="select" id="partnerId" name="partnerId">
              {otherPartners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.displayName}
                </option>
              ))}
            </select>
          </div>
          <button className="button button-secondary" type="submit" disabled={sending}>
            Hand over supervision
          </button>
        </form>
      )}
    </>
  );
}
