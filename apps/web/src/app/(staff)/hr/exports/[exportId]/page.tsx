import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet, currentAccount } from '@/lib/api';
import type { HrExport } from '@/lib/hr';
import { ExportDecision } from './export-decision';

export const metadata: Metadata = { title: 'Review HR export' };

export default async function HrExportPage({ params }: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await params;
  const [list, account] = await Promise.all([apiGet<{ exports: HrExport[] }>('/hr/exports'), currentAccount()]);
  if (!list.body || !account) throw new Error('Could not load the HR export');
  const summary = list.body.exports.find((item) => item.id === exportId); if (!summary) notFound();
  const mayReview = summary.createdBy !== account.id;
  const preview = mayReview ? await apiGet<{ id: string; sha256: string; bundle: unknown }>(`/hr/exports/${exportId}/review`) : undefined;
  return <><p><Link href="/hr/exports">Back to HR exports</Link></p><h1>Review HR export</h1>
    <dl className="summary"><dt>Person</dt><dd>{summary.personId}</dd><dt>Purpose</dt><dd>{summary.purpose.replaceAll('_', ' ')}</dd>
      <dt>Scopes</dt><dd>{summary.scopes.join(', ')}</dd><dt>SHA-256</dt><dd className="pre-wrap">{summary.sha256}</dd>
      <dt>Decision</dt><dd>{summary.decision ?? 'Awaiting review'}</dd></dl>
    {!mayReview && <div className="notice"><p>You prepared this bundle. A different active HR holder must review it.</p></div>}
    {mayReview && preview?.body && <><h2>Fixed bundle</h2><pre className="pre-wrap">{JSON.stringify(preview.body.bundle, null, 2)}</pre>
      {!summary.decision && <ExportDecision exportId={exportId} />}</>}
    {summary.decision === 'approved' && <p><a className="button" href={`/api/hr/exports/${exportId}/content`}>Download approved JSON bundle</a></p>}
  </>;
}
