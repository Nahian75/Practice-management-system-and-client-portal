import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { EmploymentSummary, PrivateRecord, LeaveRecord, HealthRecord, LifecycleRecord, VettingRecord,
  CompetenceRecord } from '@/components/hr-record-sections';
import { apiGet } from '@/lib/api';
import type { HrAdjustments, HrCompetence, HrHealthRecord, HrLeaveRecord, HrLifecycle, HrPersonRecord, HrVetting } from '@/lib/hr';
import { SelfServiceActions } from './self-service-actions';

export const metadata: Metadata = { title: 'My record' };

export default async function MyRecordPage() {
  const [person, leave, health, adjustments, lifecycle, vetting, competence] = await Promise.all([
    apiGet<HrPersonRecord>('/hr/me'), apiGet<HrLeaveRecord>('/hr/me/leave'), apiGet<HrHealthRecord>('/hr/me/health'),
    apiGet<HrAdjustments>('/hr/me/adjustments'), apiGet<HrLifecycle>('/hr/me/lifecycle'),
    apiGet<HrVetting>('/hr/me/vetting'), apiGet<HrCompetence>('/hr/me/competence'),
  ]);
  if (person.status === 404) return <NoAccess what="an HR record for your account" />;
  if (!person.body || !leave.body || !health.body || !adjustments.body || !lifecycle.body || !vetting.body || !competence.body) {
    throw new Error('Could not load your HR record');
  }
  return <>
    <p><Link href="/people">Back to People</Link></p><h1>My record</h1>
    <p className="secondary">Your private record. Only authorised HR staff can see the full HR view.</p>
    <EmploymentSummary person={person.body} /><PrivateRecord person={person.body} />
    <LeaveRecord record={leave.body} /><HealthRecord health={health.body} adjustments={adjustments.body} />
    <LifecycleRecord record={lifecycle.body} /><VettingRecord record={vetting.body} />
    <CompetenceRecord record={competence.body} />
    <SelfServiceActions person={person.body} leave={leave.body} competence={competence.body} />
  </>;
}
