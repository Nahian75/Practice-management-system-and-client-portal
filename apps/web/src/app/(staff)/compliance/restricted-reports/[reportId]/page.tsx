import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { RestrictedReport } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { RestrictedActions } from './restricted-actions';

export const metadata: Metadata = { title: 'Restricted report' };

interface Access { id: string; action: 'view' | 'download' | 'export'; attachmentId: string | null; accessedBy: string; accessedAt: string }

export default async function RestrictedReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const [detail, history] = await Promise.all([
    apiGet<RestrictedReport>(`/compliance/restricted-reports/${encodeURIComponent(reportId)}`),
    apiGet<{ accesses: Access[] }>(`/compliance/restricted-reports/${encodeURIComponent(reportId)}/accesses`),
  ]);
  if (detail.status === 404 || !detail.body || !history.body) notFound();
  const report = detail.body;
  return <>
    <p><Link href="/compliance/restricted-reports">Back to protected queue</Link></p><h1>Restricted report</h1>
    <div className="notice"><p><strong>Nominated-officer access only.</strong> This page is not part of the ordinary client or matter history.</p></div>
    <dl className="summary"><div><dt>Receipt</dt><dd>{report.id}</dd></div><div><dt>Client id</dt><dd>{report.clientId}</dd></div>
      <div><dt>Matter id</dt><dd>{report.matterId ?? 'Not linked'}</dd></div><div><dt>Finance transaction id</dt><dd>{report.financeTransactionId ?? 'Not linked'}</dd></div>
      <div><dt>Observed</dt><dd>{formatCalendarDate(report.observedOn)}</dd></div><div><dt>Received</dt><dd>{formatDateTime(report.submittedAt)}</dd></div></dl>
    <section aria-labelledby="facts-heading"><h2 id="facts-heading">Facts observed</h2><p className="pre-wrap">{report.observedFacts}</p></section>
    <section aria-labelledby="attachments-heading"><h2 id="attachments-heading">Protected attachments</h2>
      {!report.attachments.length ? <p>No attachment.</p> : <ul>{report.attachments.map((item) => <li key={item.id}><a href={`/api/compliance/restricted-reports/${report.id}/attachments/${item.id}/content`}>{item.fileName}</a> ({formatBytes(item.sizeBytes)})</li>)}</ul>}</section>
    {report.decision && <section aria-labelledby="decision-heading"><h2 id="decision-heading">Permanent decision</h2>
      <dl className="summary"><div><dt>External report required</dt><dd>{report.decision.externalReportRequired ? 'Yes' : 'No'}</dd></div>
        <div><dt>Decided</dt><dd>{formatDateTime(report.decision.decidedAt)}</dd></div><div><dt>Legal grounds</dt><dd>{report.decision.legalGrounds}</dd></div></dl></section>}
    {report.externalReport && <section aria-labelledby="external-heading"><h2 id="external-heading">External filing record</h2>
      <dl className="summary"><div><dt>Kind</dt><dd>{report.externalReport.kind === 'sar' ? 'SAR' : 'Terrorist-financing report'}</dd></div>
        <div><dt>Reference</dt><dd>{report.externalReport.reference}</dd></div><div><dt>Submitted</dt><dd>{formatDateTime(report.externalReport.submittedAt)}</dd></div>
        <div><dt>DAML/DATF requested</dt><dd>{report.externalReport.damlDatfRequested ? 'Yes' : 'No'}</dd></div></dl>
      {!!report.externalReport.events.length && <table className="table"><thead><tr><th scope="col">Outcome</th><th scope="col">Received</th><th scope="col">Reference</th><th scope="col">Legal basis</th></tr></thead>
        <tbody>{report.externalReport.events.map((event) => <tr key={event.id}><td>{event.outcome}</td><td>{formatDateTime(event.receivedAt)}</td><td>{event.externalReference}</td><td>{event.legalBasis}</td></tr>)}</tbody></table>}
    </section>}
    <RestrictedActions report={report} />
    <section aria-labelledby="access-heading"><h2 id="access-heading">Access history</h2><table className="table"><thead><tr><th scope="col">Action</th><th scope="col">Account</th><th scope="col">Time</th></tr></thead>
      <tbody>{history.body.accesses.map((item) => <tr key={item.id}><td>{item.action}</td><td>{item.accessedBy}</td><td>{formatDateTime(item.accessedAt)}</td></tr>)}</tbody></table></section>
  </>;
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`; }
