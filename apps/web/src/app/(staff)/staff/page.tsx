import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { ACCOUNT_STATUS_LABELS, STAFF_ROLE_LABELS, type StaffMember } from '@/lib/staff';

export const metadata: Metadata = { title: 'Staff' };

export default async function StaffPage({searchParams}:{searchParams:Promise<{status?:string}>}) {
  const filter=(await searchParams).status;
  const selected=filter&&['active','invited','disabled'].includes(filter)?filter:'all';
  const account=await currentAccount();
  const { status, body } = await apiGet<{ staff: StaffMember[] }>('/staff');
  if (status === 403 || !body) {
    return <NoAccess what="the staff list" />;
  }

  const canManage=body.staff.find(member=>member.id===account?.id)?.roles.includes('administrator')??false;
  const members=selected==='all'?body.staff:body.staff.filter(member=>member.status===selected);
  return (
    <>
      <h1>Staff</h1>
      <p className="secondary">Add users by invitation, assign roles and disable accounts to remove access. Account history is retained.</p>
      {canManage?<div className="actions">
        <Link className="button" href="/staff/invite">
          Add user
        </Link>
      </div>:<p>Your access is read-only. Ask an administrator to add users or change account access.</p>}
      <nav className="workspace-tabs" aria-label="Staff status">{['all','active','invited','disabled'].map(status=><Link key={status} href={status==='all'?'/staff':`/staff?status=${status}`} aria-current={selected===status?'page':undefined}>{status==='all'?'All users':ACCOUNT_STATUS_LABELS[status as keyof typeof ACCOUNT_STATUS_LABELS]} ({status==='all'?body.staff.length:body.staff.filter(member=>member.status===status).length})</Link>)}</nav>
      <div className="workspace-table-wrap"><table className="table">
        <caption className="secondary">Everyone with a staff account, including invited and disabled accounts.</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Roles</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
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
              <td>{member.id===account?.id?<span className="secondary">Your account</span>:canManage?<div className="actions"><Link href={`/staff/${member.id}#staff-roles`}>Manage roles<span className="visually-hidden"> for {member.displayName}</span></Link><Link href={`/staff/${member.id}#staff-account`}>{member.status==='disabled'?'Re-enable account':'Disable account'}<span className="visually-hidden"> for {member.displayName}</span></Link></div>:<Link href={`/staff/${member.id}`}>View account<span className="visually-hidden"> for {member.displayName}</span></Link>}</td>
            </tr>
          ))}
          {members.length===0&&<tr><td colSpan={5}>No {selected==='all'?'staff':selected} users.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
