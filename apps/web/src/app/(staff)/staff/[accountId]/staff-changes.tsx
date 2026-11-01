'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { STAFF_ROLE_LABELS, STAFF_ROLE_PURPOSES, type StaffMember, type StaffRole } from '@/lib/staff';
import { staffChangeRefusal } from '../staff-requests';

/**
 * An administrator's changes to someone's account: giving and removing roles
 * one at a time, and disabling or re-enabling the account. The API refuses
 * changes to one's own account and removing the firm's last administrator or
 * compliance holder; its reasons are shown as given.
 */
export function StaffChanges({ member }: { member: StaffMember }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [done, setDone] = useState<string>();
  const [sending, setSending] = useState(false);
  const accountPath = `/api/staff/${encodeURIComponent(member.id)}`;

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
      setErrors(await staffChangeRefusal(response));
    } finally {
      setSending(false);
    }
  }

  const changeRole = (role: StaffRole, give: boolean) =>
    send(
      () => fetch(`${accountPath}/roles/${role}`, { method: give ? 'PUT' : 'DELETE' }),
      `${STAFF_ROLE_LABELS[role]} role ${give ? 'given' : 'removed'}. ${member.displayName} has been emailed.`,
    );

  return (
    <>
      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{done && <p className="notice">{done}</p>}</div>

      <h2 id="staff-roles">Roles</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">What it is for</th>
            <th scope="col">Held</th>
            <th scope="col">
              <span className="visually-hidden">Change</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(STAFF_ROLE_LABELS) as StaffRole[]).map((role) => {
            const held = member.roles.includes(role);
            return (
              <tr key={role}>
                <td>{STAFF_ROLE_LABELS[role]}</td>
                <td>{STAFF_ROLE_PURPOSES[role]}</td>
                <td>{held ? 'Yes' : 'No'}</td>
                <td>
                  {member.status !== 'disabled' && (
                    <button className="link-button" type="button" disabled={sending} onClick={() => void changeRole(role, !held)}>
                      {held ? 'Remove' : 'Give'}
                      <span className="visually-hidden"> the {STAFF_ROLE_LABELS[role]} role</span>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="secondary">
        Giving the Administrator, Compliance or Accounts role is also emailed to everyone in compliance.
      </p>

      <h2 id="staff-account">Account access</h2>
      {member.status === 'disabled' ? (
        <>
          <p>
            Re-enabling does not restore the old password: they are emailed a new invitation and set a new password and
            authenticator.
          </p>
          <button
            className="button button-secondary"
            type="button"
            disabled={sending}
            onClick={() =>
              void send(() => fetch(`${accountPath}/enable`, { method: 'POST' }), `Re-enabled. ${member.displayName} has been sent a new invitation.`)
            }
          >
            Re-enable the account
          </button>
        </>
      ) : (
        <>
          <p>
            Disabling signs them out everywhere at once, and they can no longer sign in. Their roles and their place on
            matter teams stay, so a partner can take over supervision where needed.
          </p>
          <button
            className="button button-warning"
            type="button"
            disabled={sending}
            onClick={() => void send(() => fetch(`${accountPath}/disable`, { method: 'POST' }), 'Disabled. They have been signed out.')}
          >
            Disable the account
          </button>
        </>
      )}
    </>
  );
}
