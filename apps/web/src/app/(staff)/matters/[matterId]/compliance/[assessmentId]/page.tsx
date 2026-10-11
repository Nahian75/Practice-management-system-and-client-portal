import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { AmlClearance, AssessmentWork, RiskAssessment } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { AssessmentActions } from './assessment-actions';

export const metadata: Metadata = { title: 'AML assessment work' };

export default async function AssessmentPage({ params }: { params: Promise<{ matterId: string; assessmentId: string }> }) {
  const { matterId, assessmentId } = await params;
  const [risk, work, clearance, access] = await Promise.all([
    apiGet<RiskAssessment>(`/matters/${encodeURIComponent(matterId)}/aml-risk/${encodeURIComponent(assessmentId)}`),
    apiGet<AssessmentWork>(`/matters/${encodeURIComponent(matterId)}/aml-risk/${encodeURIComponent(assessmentId)}/work`),
    apiGet<{ clearance: AmlClearance | null }>(`/matters/${encodeURIComponent(matterId)}/aml-risk/${encodeURIComponent(assessmentId)}/clearance`),
    apiGet('/compliance/access'),
  ]);
  if (!risk.body || !work.body || !clearance.body) notFound();
  return <><p><Link href={`/matters/${matterId}/compliance`}>Back to matter AML record</Link></p>
    <h1>AML assessment version {risk.body.version}</h1>
    <p><strong>Rating:</strong> {risk.body.rating}. <strong>Review due:</strong> {formatCalendarDate(risk.body.reviewDueOn)}. <strong>Prepared by:</strong> {risk.body.preparedBy.displayName}.</p>
    <dl>{Object.entries(risk.body.narrative).filter(([, value]) => value).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{value}</dd></div>)}</dl>
    <section aria-labelledby="measures-heading"><h2 id="measures-heading">CDD and enhanced measures</h2>
      {!work.body.measures.length ? <p>No measures recorded.</p> : work.body.measures.map((measure) => <article key={measure.id}><h3>{label(measure.kind)}{measure.enhanced ? ' (enhanced)' : ''}</h3><p>{measure.description}</p>{!measure.results.length ? <p className="secondary">No result yet.</p> : <ul>{measure.results.map((result) => <li key={result.id}><strong>{label(result.outcome)}:</strong> {result.reasoning} ({formatDateTime(result.recordedAt)})</li>)}</ul>}</article>)}
    </section>
    <section aria-labelledby="sources-heading"><h2 id="sources-heading">Source conclusions</h2>{!work.body.conclusions.length ? <p>No source-of-funds or source-of-wealth conclusion.</p> : <ul>{work.body.conclusions.map((item) => <li key={item.id}><strong>Source of {item.kind}</strong>: {item.outcome.replace('_', ' ')}; GBP {(Number(item.amountMinPence) / 100).toFixed(2)} to {(Number(item.amountMaxPence) / 100).toFixed(2)}. {item.reasoning}</li>)}</ul>}</section>
    {clearance.body.clearance && <section aria-labelledby="clearance-heading"><h2 id="clearance-heading">Compliance decision</h2><p><strong>{label(clearance.body.clearance.decision)}:</strong> {clearance.body.clearance.reasoning}</p><p>Decided by {clearance.body.clearance.decidedBy.displayName} on {formatDateTime(clearance.body.clearance.decidedAt)}. {clearance.body.clearance.needsSenior && !clearance.body.clearance.seniorApproval ? 'Senior approval is still required.' : ''}{clearance.body.clearance.seniorApproval ? ` Senior approval recorded by ${clearance.body.clearance.seniorApproval.approvedBy.displayName}.` : ''}</p></section>}
    <AssessmentActions matterId={matterId} assessmentId={assessmentId} work={work.body} clearance={clearance.body.clearance} canClear={access.status === 200} />
  </>;
}

function label(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
