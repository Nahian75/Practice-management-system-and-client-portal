import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet, currentAccount } from '@/lib/api';
import type { HrCaseDetail, HrDirectoryMember } from '@/lib/hr';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { CaseActions } from './case-actions';

export const metadata: Metadata = { title: 'Confidential HR case' };

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const [detail, account] = await Promise.all([apiGet<HrCaseDetail>(`/hr/cases/${caseId}`), currentAccount()]);
  if (detail.status === 404) notFound();
  if (!detail.body || !account) throw new Error('Could not load the confidential case');
  const ownMembership = detail.body.members.find((item) => item.accountId === account.id && !item.ending);
  const isHrMember = ownMembership?.role === 'hr_member';
  const state = [...detail.body.events].reverse().find((item) => item.kind === 'status')?.state ?? 'open';
  const [directory, accesses] = await Promise.all([
    apiGet<{ people: HrDirectoryMember[] }>('/hr/directory'),
    isHrMember ? apiGet<{ accesses: Array<{ id: string; action: string; accessedBy: string; accessedAt: string }> }>(`/hr/cases/${caseId}/accesses`)
      : Promise.resolve({ status: 200, body: { accesses: [] } }),
  ]);
  return <><p><Link href="/people/cases">Back to My confidential cases</Link></p><h1>{detail.body.kind} case</h1>
    <p className="secondary">Case reference {detail.body.id}. Access is recorded.</p>
    <dl className="summary"><dt>State</dt><dd>{state.replaceAll('_', ' ')}</dd>
      <dt>Due</dt><dd>{detail.body.dueOn ? formatCalendarDate(detail.body.dueOn) : 'Not set'}</dd>
      <dt>Policy version</dt><dd>{detail.body.policyVersion}</dd><dt>Issue</dt><dd className="pre-wrap">{detail.body.issue}</dd></dl>
    <section aria-labelledby="members-heading"><h2 id="members-heading">Case team</h2><table className="table"><thead><tr>
      <th scope="col">Account</th><th scope="col">Role</th><th scope="col">Status</th></tr></thead><tbody>
      {detail.body.members.map((member) => <tr key={member.id}><td>{directory.body?.people.find((item) => item.accountId === member.accountId)?.displayName ?? member.accountId}</td>
        <td>{member.role.replaceAll('_', ' ')}</td><td>{member.ending ? `Ended ${formatDateTime(member.ending.endedAt)}` : 'Current'}</td></tr>)}</tbody></table></section>
    <section aria-labelledby="case-history-heading"><h2 id="case-history-heading">Case history</h2>
      {!detail.body.events.length ? <p>No events recorded.</p> : detail.body.events.map((event) => <article key={event.id}>
        <h3>{event.kind.replaceAll('_', ' ')} — {formatCalendarDate(event.occurredOn)}</h3><p><strong>{event.summary}</strong></p>
        <p className="pre-wrap">{event.details}</p>{event.evidenceReference && <p>Evidence: {event.evidenceReference}</p>}
      </article>)}</section>
    <CaseActions caseId={caseId} eventIds={detail.body.events.map((item) => item.id)} role={ownMembership?.role}
      memberships={detail.body.members.filter((item) => !item.ending).map((item) => ({ id: item.id, role: item.role }))}
      people={directory.body?.people ?? []} />
    {isHrMember && <section aria-labelledby="access-heading"><h2 id="access-heading">Recent access</h2>
      {!accesses.body?.accesses.length ? <p>No earlier access records.</p> : <ul>{accesses.body.accesses.map((item) =>
        <li key={item.id}>{item.action} by {item.accessedBy} at {formatDateTime(item.accessedAt)}</li>)}</ul>}</section>}
  </>;
}
