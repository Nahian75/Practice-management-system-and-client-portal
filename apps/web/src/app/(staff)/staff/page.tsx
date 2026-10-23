import type { Metadata } from 'next';
import Link from 'next/link';
import { HowTo } from '@/components/how-to';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { ACCOUNT_STATUS_LABELS, STAFF_ROLE_LABELS, type StaffMember } from '@/lib/staff';

export const metadata: Metadata = { title: 'Staff' };

export default async function StaffPage() {
  const { status, body } = await apiGet<{ staff: StaffMember[] }>('/staff');
  if (status === 403 || !body) {
    return <NoAccess what="the staff list" />;
  }

  return (
    <>
      <h1>Staff</h1>
      <HowTo>
        <li>Select &ldquo;Invite someone&rdquo; to give a new colleague an account. They get an email to set their password.</li>
        <li>Select a name to change that person&rsquo;s roles or account status.</li>
        <li>Roles decide what each person can see and do, so give only the roles they need.</li>
      </HowTo>
      <div className="actions">
        <Link className="button" href="/staff/invite">
          Invite someone
        </Link>
      </div>
      <table className="table">
        <caption className="secondary">Everyone with a staff account, including invited and disabled accounts.</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Roles</th>
          </tr>
        </thead>
        <tbody>
          {body.staff.map((member) => (
            <tr key={member.id}>
              <td>
                <Link href={`/staff/${member.id}`}>{member.displayName}</Link>
              </td>
              <td>{member.email}</td>
              <td>{ACCOUNT_STATUS_LABELS[member.status]}</td>
              <td>
                {member.roles.length === 0 ? (
                  <span className="secondary">None</span>
                ) : (
                  member.roles.map((role) => STAFF_ROLE_LABELS[role]).join(', ')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
