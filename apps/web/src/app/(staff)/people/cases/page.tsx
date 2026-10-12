import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { HrCaseSummary } from '@/lib/hr';
import { formatCalendarDate, formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'My confidential cases' };

export default async function MyCasesPage() {
  const { body } = await apiGet<{ cases: HrCaseSummary[] }>('/hr/cases');
  if (!body) throw new Error('Could not load confidential cases');
  return <><p><Link href="/people">Back to People</Link></p><h1>My confidential cases</h1>
    <p className="secondary">Only cases where you are a current explicit case member appear.</p>
    {!body.cases.length ? <p>You have no assigned cases.</p> : <table className="table"><thead><tr><th scope="col">Case</th>
      <th scope="col">State</th><th scope="col">Due</th><th scope="col">Opened</th></tr></thead><tbody>
      {body.cases.map((item) => <tr key={item.id}><td><Link href={`/people/cases/${item.id}`}>{item.kind}</Link></td>
        <td>{item.state.replaceAll('_', ' ')}</td><td>{item.dueOn ? formatCalendarDate(item.dueOn) : 'Not set'}</td>
        <td>{formatDateTime(item.openedAt)}</td></tr>)}</tbody></table>}
  </>;
}
