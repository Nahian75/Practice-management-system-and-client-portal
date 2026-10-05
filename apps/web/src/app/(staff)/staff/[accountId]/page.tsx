import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { ACCOUNT_STATUS_LABELS, STAFF_ROLE_LABELS, type StaffMember } from '@/lib/staff';
import { StaffChanges } from './staff-changes';

export const metadata: Metadata = { title: 'Staff member' };

export default async function StaffMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ invited?: string | string[] }>;
}) {
  const { accountId } = await params;
  const { invited } = await searchParams;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body } = await apiGet<{ staff: StaffMember[] }>('/staff');
  if (status === 403 || !body) {
    return <NoAccess what="the staff list" />;
  }
  const member = body.staff.find((candidate) => candidate.id === accountId);
  if (!member) {
    return (
      <>
        <h1>No such staff member</h1>
        <p>
          <Link href="/staff">Back to staff</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <p>
        <Link href="/staff">Back to staff</Link>
      </p>
      <span className="caption">{ACCOUNT_STATUS_LABELS[member.status]}</span>
      <h1>{member.displayName}</h1>
      {invited === '1' && member.status === 'invited' && (
        <p className="notice">Invitation sent to {member.email}. Give them their roles below.</p>
      )}
      <dl className="summary">
        <div className="summary-row">
          <dt>Email</dt>
          <dd>{member.email}</dd>
        </div>
        <div className="summary-row">
          <dt>Roles</dt>
          <dd>{member.roles.length === 0 ? 'None' : member.roles.map((role) => STAFF_ROLE_LABELS[role]).join(', ')}</dd>
        </div>
      </dl>
      {member.id === account.id ? (
        <p>This is your own account. Another administrator changes your roles or disables it, so nobody can lock out the firm alone.</p>
      ) : (
        <StaffChanges member={member} />
      )}
    </>
  );
}
