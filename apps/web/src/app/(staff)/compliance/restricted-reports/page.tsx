import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { RestrictedReportSummary } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Nominated-officer records' };

export default async function RestrictedReportsPage() {
  const result = await apiGet<{ reports: RestrictedReportSummary[]; next: string | null }>('/compliance/restricted-reports');
  if (result.status === 404 || !result.body) notFound();
  return <>
    <p><Link href="/compliance">Back to Compliance</Link></p><h1>Nominated-officer records</h1>
    <div className="notice"><p><strong>Restricted.</strong> Do not copy details into ordinary matter notes, tasks, email or notifications.</p></div>
    {!result.body.reports.length ? <p>No reports in this protected queue.</p> : <table className="table"><thead><tr><th scope="col">Receipt</th><th scope="col">Observed</th><th scope="col">Received</th><th scope="col">Decision</th></tr></thead>
      <tbody>{result.body.reports.map((report) => <tr key={report.id}><td><Link href={`/compliance/restricted-reports/${report.id}`}>{report.id}</Link></td>
        <td>{formatCalendarDate(report.observedOn)}</td><td>{formatDateTime(report.submittedAt)}</td><td>{report.decided ? 'Recorded' : 'Required'}</td></tr>)}</tbody></table>}
  </>;
}
