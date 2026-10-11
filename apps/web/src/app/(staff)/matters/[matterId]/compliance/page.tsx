import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { ComplianceGate, RiskSummary } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { Matter } from '@/lib/matters';
import { MatterComplianceForms } from './matter-compliance-forms';

export const metadata: Metadata = { title: 'Matter AML assessment' };

export default async function MatterCompliancePage({ params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  const [matter, gate, risks, complianceAccess, reviews] = await Promise.all([
    apiGet<Matter>(`/matters/${encodeURIComponent(matterId)}`),
    apiGet<ComplianceGate>(`/matters/${encodeURIComponent(matterId)}/aml-gate`),
    apiGet<{ assessments: RiskSummary[]; next: string | null }>(`/matters/${encodeURIComponent(matterId)}/aml-risk`),
    apiGet('/compliance/access'),
    apiGet<{ matters: Array<{ matterId: string; reference: string }>; next: string | null }>('/compliance/reviews'),
  ]);
  if (!risks.body) notFound();
  const protectedSummary = reviews.body?.matters.find((item) => item.matterId === matterId);
  const reference = matter.body?.reference ?? protectedSummary?.reference ?? 'Matter';
  return <>
    <p><Link href={matter.body ? `/matters/${matterId}` : '/compliance'}>Back to {matter.body ? 'matter' : 'Compliance'}</Link></p><h1>{reference}: AML assessment</h1>
    <p className="secondary">Internal risk reasoning and evidence. A numerical label never replaces the written assessment.</p>
    {gate.body && <div className={`notice ${gate.body.state === 'cleared' ? '' : 'notice-warning'}`}><p><strong>Gate: {gate.body.state.replace('_', ' ')}.</strong>{gate.body.dueSince ? ` Due since ${formatCalendarDate(gate.body.dueSince)}.` : ''}</p></div>}
    <MatterComplianceForms matterId={matterId} assessments={risks.body.assessments} matterOpen={matter.body?.status !== 'closed'}
      canClear={complianceAccess.status === 200} />
    <section aria-labelledby="history-heading"><h2 id="history-heading">Assessment history</h2>
      {!risks.body.assessments.length ? <p>No assessment has been recorded.</p> : <table className="table"><thead><tr><th scope="col">Version</th><th scope="col">Scope</th><th scope="col">Rating</th><th scope="col">Review due</th><th scope="col">Prepared by</th><th scope="col">Submitted</th></tr></thead>
        <tbody>{risks.body.assessments.map((item) => <tr key={item.id}><td><Link href={`/matters/${matterId}/compliance/${item.id}`}>Version {item.version}</Link></td><td>{item.inScope ? 'In scope' : 'Out of scope'}</td><td>{item.rating}</td>
          <td>{formatCalendarDate(item.reviewDueOn)}</td><td>{item.preparedBy.displayName}</td><td>{formatDateTime(item.submittedAt)}</td></tr>)}</tbody></table>}
    </section>
  </>;
}
