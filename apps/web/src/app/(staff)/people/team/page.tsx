import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { HrDirectoryMember } from '@/lib/hr';

export const metadata: Metadata = { title: 'My team' };

export default async function MyTeamPage() {
  const { body } = await apiGet<{ people: HrDirectoryMember[] }>('/hr/reports');
  if (!body) throw new Error('Could not load your team');
  return <><p><Link href="/people">Back to People</Link></p><h1>My team</h1>
    <p className="secondary">Only current direct reports appear. Private contact, pay, medical and case information is not included.</p>
    {!body.people.length ? <p>You have no current direct reports.</p> : <table className="table"><thead><tr>
      <th scope="col">Name</th><th scope="col">Role</th><th scope="col">Team</th><th scope="col">Location</th></tr></thead><tbody>
      {body.people.map((person) => <tr key={person.personId}><td><Link href={`/people/team/${person.personId}`}>{person.displayName}</Link></td>
        <td>{person.jobTitle ?? 'Not recorded'}</td><td>{person.team ?? 'Not recorded'}</td><td>{person.workLocation ?? 'Not recorded'}</td></tr>)}</tbody></table>}
  </>;
}
