import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { hasHrWorkspace, type HrAccess, type HrCaseSummary, type HrDirectoryMember } from '@/lib/hr';

export const metadata: Metadata = { title: 'People' };

export default async function PeoplePage() {
  const [directory, access, cases] = await Promise.all([
    apiGet<{ people: HrDirectoryMember[] }>('/hr/directory'), apiGet<HrAccess>('/hr/access'),
    apiGet<{ cases: HrCaseSummary[] }>('/hr/cases'),
  ]);
  if (!directory.body || !access.body || !cases.body) throw new Error('Could not load People');
  return <>
    <h1>People</h1>
    <p className="secondary">Your work directory and private employment self-service.</p>
    <nav aria-label="People sections" className="section-nav"><ul>
      {access.body.personId && <li><Link href="/people/me">My record</Link></li>}
      {access.body.reportCount > 0 && <li><Link href="/people/team">My team ({access.body.reportCount})</Link></li>}
      {cases.body.cases.length > 0 && <li><Link href="/people/cases">My confidential cases ({cases.body.cases.length})</Link></li>}
      {hasHrWorkspace(access.body) && <li><Link href="/hr">HR workspace</Link></li>}
    </ul></nav>
    {!access.body.personId && <div className="notice notice-warning"><p>Your own HR record has not been set up yet. The work directory remains available.</p></div>}
    <table className="table"><caption>Active staff directory</caption><thead><tr><th scope="col">Name</th>
      <th scope="col">Role</th><th scope="col">Team</th><th scope="col">Location</th><th scope="col">Work email</th></tr></thead>
      <tbody>{directory.body.people.map((person) => <tr key={person.accountId}><td>{person.displayName}</td>
        <td>{person.jobTitle ?? 'Not recorded'}</td><td>{person.team ?? 'Not recorded'}</td>
        <td>{person.workLocation ?? 'Not recorded'}</td><td><a href={`mailto:${person.workEmail}`}>{person.workEmail}</a></td></tr>)}</tbody>
    </table>
  </>;
}
