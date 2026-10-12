import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompetenceRecord, EmploymentSummary, HealthRecord, LeaveRecord, LifecycleRecord, VettingRecord } from '@/components/hr-record-sections';
import { apiGet } from '@/lib/api';
import type { HrAdjustments, HrCompetence, HrLeaveRecord, HrLifecycle, HrPersonSummary, HrVetting } from '@/lib/hr';
import { ManagerActions } from './manager-actions';

export const metadata: Metadata = { title: 'Direct report' };

export default async function DirectReportPage({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const [person, leave, adjustments, lifecycle, vetting, competence] = await Promise.all([
    apiGet<HrPersonSummary>(`/hr/reports/${personId}`), apiGet<HrLeaveRecord>(`/hr/reports/${personId}/leave`),
    apiGet<HrAdjustments>(`/hr/reports/${personId}/adjustments`), apiGet<HrLifecycle>(`/hr/reports/${personId}/lifecycle`),
    apiGet<HrVetting>(`/hr/reports/${personId}/vetting`), apiGet<HrCompetence>(`/hr/reports/${personId}/competence`),
  ]);
  if ([person, leave, adjustments, lifecycle, vetting, competence].some((response) => response.status === 404)) notFound();
  if (!person.body || !leave.body || !adjustments.body || !lifecycle.body || !vetting.body || !competence.body) {
    throw new Error('Could not load the direct-report record');
  }
  return <><p><Link href="/people/team">Back to My team</Link></p><h1>{person.body.displayName}</h1>
    <p className="secondary">Current-manager view. It deliberately excludes private contact, pay, medical and confidential-case fields.</p>
    <EmploymentSummary person={person.body} /><LeaveRecord record={leave.body} />
    <HealthRecord adjustments={adjustments.body} /><LifecycleRecord record={lifecycle.body} />
    <VettingRecord record={vetting.body} /><CompetenceRecord record={competence.body} />
    <ManagerActions personId={personId} leave={leave.body} adjustments={adjustments.body} competence={competence.body} />
  </>;
}
