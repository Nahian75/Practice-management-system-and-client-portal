import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { HrExport } from '@/lib/hr';

export const metadata: Metadata = { title: 'HR exports' };

export default async function HrExportsPage() {
  const result = await apiGet<{ exports: HrExport[] }>('/hr/exports');
  if (result.status === 403) return <NoAccess what="HR exports" />;
  if (!result.body) throw new Error('Could not load HR exports');
  return <><p><Link href="/hr">Back to HR workspace</Link></p><h1>Reviewed HR exports</h1>
    <p className="secondary">A different active HR holder must inspect and approve the fixed encrypted bundle before download.</p>
    {!result.body.exports.length ? <p>No exports prepared.</p> : <table className="table"><thead><tr><th scope="col">Export</th>
      <th scope="col">Purpose</th><th scope="col">Scopes</th><th scope="col">Prepared</th><th scope="col">Decision</th></tr></thead><tbody>
      {result.body.exports.map((item) => <tr key={item.id}><td><Link href={`/hr/exports/${item.id}`}>{item.personId}</Link></td>
        <td>{item.purpose.replaceAll('_', ' ')}</td><td>{item.scopes.join(', ')}</td><td>{formatDateTime(item.createdAt)}</td>
        <td>{item.decision ?? 'Awaiting review'}</td></tr>)}</tbody></table>}
  </>;
}
