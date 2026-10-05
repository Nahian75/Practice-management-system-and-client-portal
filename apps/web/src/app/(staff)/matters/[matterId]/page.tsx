import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ConflictResults } from '@/components/conflict-results';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { formatDate } from '@/lib/format';
import {
  MATTER_STATUS_LABELS,
  MATTER_TYPE_LABELS,
  PARTY_ROLE_LABELS,
  TEAM_ROLE_LABELS,
  type ConflictCheck,
  type Matter,
} from '@/lib/matters';
import { ClearanceForm } from './clearance-form';

export const metadata: Metadata = { title: 'Matter' };

export default async function MatterPage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body: matter } = await apiGet<Matter>(`/matters/${encodeURIComponent(matterId)}`);
  if (status === 403) {
    return <NoAccess what="matters" />;
  }
  if (status === 400) {
    notFound();
  }
  if (!matter) {
    // The same answer for a matter that does not exist and one the person is not on the team of.
    return (
      <>
        <h1>You cannot see this matter</h1>
        <p>Either there is no such matter, or you are not on its team. Its supervising partner can add you.</p>
      </>
    );
  }

  const check = await apiGet<ConflictCheck>(`/matters/${encodeURIComponent(matter.id)}/conflict-check`);
  const isSupervisor = matter.team.some((member) => member.accountId === account.id && member.role === 'supervising_partner');

  return (
    <>
      <span className="caption">
        {matter.reference} · {MATTER_STATUS_LABELS[matter.status]}
      </span>
      <h1>{matter.title}</h1>

      {matter.status === 'awaiting_clearance' && (
        <div className="notice">
          <p>
            <strong>Awaiting conflict clearance.</strong> The conflict check found possible conflicts. No work should start
            until the supervising partner has recorded why they are not a conflict.
          </p>
        </div>
      )}

      <dl className="summary">
        {(
          [
            ['Client', <Link key="client" href={`/clients/${matter.client.id}`}>{`${matter.client.name} (${matter.client.reference})`}</Link>],
            ['Type of work', MATTER_TYPE_LABELS[matter.matterType]],
            ['Opened', formatDate(matter.openedAt)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="summary-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h2>Team</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {matter.team.map((member) => (
            <tr key={member.accountId}>
              <td>{member.displayName}</td>
              <td>{TEAM_ROLE_LABELS[member.role]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Other parties</h2>
      {matter.parties.length === 0 ? (
        <p>None.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Person or organisation</th>
            </tr>
          </thead>
          <tbody>
            {matter.parties.map((party) => (
              <tr key={party.id}>
                <td>{party.name}</td>
                <td>{PARTY_ROLE_LABELS[party.role]}</td>
                <td>{party.kind === 'individual' ? 'Person' : 'Organisation'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Conflict check</h2>
      {check.body ? (
        <>
          <p className="secondary">Run on {formatDate(check.body.createdAt)}.</p>
          <ConflictResults check={check.body} />
          {check.body.clearance && (
            <dl className="summary">
              <div className="summary-row">
                <dt>Cleared by</dt>
                <dd>
                  {check.body.clearance.clearedBy.displayName}, {formatDate(check.body.clearance.clearedAt)}
                </dd>
              </div>
              <div className="summary-row">
                <dt>Why it is not a conflict</dt>
                <dd>{check.body.clearance.reason}</dd>
              </div>
            </dl>
          )}
        </>
      ) : (
        <p>The conflict check could not be loaded. Reload the page to try again.</p>
      )}

      {matter.status === 'awaiting_clearance' && isSupervisor && <ClearanceForm matterId={matter.id} />}
    </>
  );
}
