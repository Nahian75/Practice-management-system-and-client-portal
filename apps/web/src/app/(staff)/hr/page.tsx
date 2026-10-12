import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { hasHrWorkspace, type HrAccess, type HrCaseSummary, type HrCorrection, type HrDirectoryMember,
  type HrDisposal, type HrExport, type HrLeaveRequest, type HrRetentionRule, type HrRetentionSchedule } from '@/lib/hr';
import { HrWorkspaceActions } from './workspace-actions';

export const metadata: Metadata = { title: 'HR workspace' };

interface PersonChoice extends HrDirectoryMember { personId: string; accountStatus?: string }
interface DueCheck { personId: string; displayName: string; result: string; expiresOn: string | null; followUpOn: string | null; overdue: boolean }

export default async function HrWorkspacePage() {
  const [accessResult, directoryResult] = await Promise.all([
    apiGet<HrAccess>('/hr/access'), apiGet<{ people: HrDirectoryMember[] }>('/hr/directory'),
  ]);
  const access = accessResult.body;
  if (!access || !hasHrWorkspace(access)) return <NoAccess what="the HR workspace" />;
  if (!directoryResult.body) throw new Error('Could not load the HR directory');
  const [people, corrections, leave, due, cases, rules, schedules, disposals, exports] = await Promise.all([
    load<{ people: PersonChoice[] }>(access.canManagePeople, '/hr/people', { people: [] }),
    load<{ corrections: Array<HrCorrection & { displayName: string }> }>(access.canManagePeople, '/hr/corrections', { corrections: [] }),
    load<{ requests: Array<HrLeaveRequest & { displayName: string }> }>(access.canManageLeave, '/hr/leave/requests', { requests: [] }),
    load<{ checks: DueCheck[] }>(access.canManageVetting, '/hr/vetting/due', { checks: [] }),
    load<{ cases: HrCaseSummary[] }>(access.canManageCases, '/hr/cases', { cases: [] }),
    load<{ rules: HrRetentionRule[] }>(access.canManageRetention, '/hr/retention/rules', { rules: [] }),
    load<{ schedules: HrRetentionSchedule[] }>(access.canManageRetention, '/hr/retention/schedules', { schedules: [] }),
    load<{ disposals: HrDisposal[] }>(access.canManageRetention, '/hr/retention/disposals', { disposals: [] }),
    load<{ exports: HrExport[] }>(access.canManageExports, '/hr/exports', { exports: [] }),
  ]);
  const names = new Map(directoryResult.body.people.filter((item) => item.personId).map((item) => [item.personId!, item.displayName]));
  return <><h1>HR workspace</h1>
    <p className="secondary">Personnel administration and evidence. Account roles, client ownership and other modules remain with their owners.</p>
    <nav aria-label="HR sections" className="section-nav"><ul><li><Link href="/people">People directory</Link></li>
      {access.canManageRetention && <li><Link href="/hr/retention">Retention and disposal</Link></li>}
      {access.canManageExports && <li><Link href="/hr/exports">Reviewed exports</Link></li>}</ul></nav>
    <HrWorkspaceActions access={access} directory={directoryResult.body.people} people={people.people}
      rules={rules.rules} />

    {access.canManagePeople && <section aria-labelledby="personnel-heading"><h2 id="personnel-heading">Personnel records</h2>
      {!people.people.length ? <p>No personnel records.</p> : <table className="table"><thead><tr><th scope="col">Person</th>
        <th scope="col">Role</th><th scope="col">Status</th></tr></thead><tbody>{people.people.map((person) => <tr key={person.personId}>
          <td><Link href={`/hr/people/${person.personId}`}>{person.displayName}</Link></td><td>{person.jobTitle ?? 'Not recorded'}</td>
          <td>{person.accountStatus ?? 'active'}</td></tr>)}</tbody></table>}
      {!!corrections.corrections.length && <><h3>Correction requests</h3><ul>{corrections.corrections.map((item) =>
        <li key={item.id}><Link href={`/hr/people/${item.personId}`}>{item.displayName}</Link>: {item.category} — {item.outcome ?? 'awaiting decision'}</li>)}</ul></>}
    </section>}
    {access.canManageLeave && <section aria-labelledby="leave-queue-heading"><h2 id="leave-queue-heading">Pending leave</h2>
      {!leave.requests.length ? <p>No pending requests.</p> : <ul>{leave.requests.map((item) => <li key={item.id}>
        <Link href={`/hr/people/${item.personId}`}>{item.displayName}</Link>: {item.kind}, {formatCalendarDate(item.startsOn)} to {formatCalendarDate(item.endsOn)}</li>)}</ul>}
    </section>}
    {access.canManageVetting && <section aria-labelledby="vetting-due-heading"><h2 id="vetting-due-heading">Right-to-work actions</h2>
      {!due.checks.length ? <p>No checks due in the next 30 days.</p> : <ul>{due.checks.map((item) => <li key={item.personId}>
        <Link href={`/hr/people/${item.personId}`}>{item.displayName}</Link>: {item.result.replaceAll('_', ' ')}
        {item.followUpOn ? `; follow up ${formatCalendarDate(item.followUpOn)}` : ''}</li>)}</ul>}
    </section>}
    {access.canManageCases && <section aria-labelledby="cases-heading"><h2 id="cases-heading">Assigned confidential cases</h2>
      {!cases.cases.length ? <p>No assigned cases.</p> : <table className="table"><thead><tr><th scope="col">Person</th>
        <th scope="col">Case</th><th scope="col">State</th><th scope="col">Due</th></tr></thead><tbody>{cases.cases.map((item) =>
          <tr key={item.id}><td>{names.get(item.personId) ?? item.personId}</td><td><Link href={`/people/cases/${item.id}`}>{item.kind}</Link></td>
            <td>{item.state}</td><td>{item.dueOn ? formatCalendarDate(item.dueOn) : 'Not set'}</td></tr>)}</tbody></table>}
    </section>}
    {access.canManageRetention && <section aria-labelledby="retention-summary-heading"><h2 id="retention-summary-heading">Retention</h2>
      <p>{rules.rules.length} rule version{rules.rules.length === 1 ? '' : 's'}, {schedules.schedules.length} schedule{schedules.schedules.length === 1 ? '' : 's'}, and {disposals.disposals.length} disposal run{disposals.disposals.length === 1 ? '' : 's'}.</p>
      <p><Link href="/hr/retention">Open retention and disposal</Link></p></section>}
    {access.canManageExports && <section aria-labelledby="exports-summary-heading"><h2 id="exports-summary-heading">Exports awaiting review</h2>
      {!exports.exports.filter((item) => !item.decision).length ? <p>No exports awaiting a decision.</p> : <ul>
        {exports.exports.filter((item) => !item.decision).map((item) => <li key={item.id}><Link href={`/hr/exports/${item.id}`}>{names.get(item.personId) ?? item.personId}</Link>,
          {' '}{item.purpose.replaceAll('_', ' ')}, prepared {formatDateTime(item.createdAt)}</li>)}</ul>}
    </section>}
  </>;
}

async function load<T>(allowed: boolean, path: `/${string}`, empty: T): Promise<T> {
  if (!allowed) return empty;
  const result = await apiGet<T>(path);
  if (!result.body) throw new Error(`Could not load ${path}`);
  return result.body;
}
