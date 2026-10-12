import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompetenceRecord, EmploymentSummary, HealthRecord, LeaveRecord, LifecycleRecord, PrivateRecord,
  VettingRecord } from '@/components/hr-record-sections';
import { apiGet } from '@/lib/api';
import type { HrAccess, HrAdjustments, HrCompetence, HrDirectoryMember, HrHealthRecord, HrLeaveRecord,
  HrLifecycle, HrPersonRecord, HrVetting } from '@/lib/hr';
import { HrPersonActions } from './person-actions';

export const metadata: Metadata = { title: 'HR personnel record' };

export default async function HrPersonPage({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const [access, person, directory] = await Promise.all([
    apiGet<HrAccess>('/hr/access'), apiGet<HrPersonRecord>(`/hr/people/${personId}`),
    apiGet<{ people: HrDirectoryMember[] }>('/hr/directory'),
  ]);
  if (person.status === 404) notFound();
  if (!access.body || !person.body || !directory.body) throw new Error('Could not load the personnel record');
  const [leave, health, adjustments, lifecycle, vetting, competence] = await Promise.all([
    optional<HrLeaveRecord>(access.body.canManageLeave, `/hr/people/${personId}/leave`),
    optional<HrHealthRecord>(access.body.canManageHealth, `/hr/people/${personId}/health`),
    optional<HrAdjustments>(access.body.canManageHealth, `/hr/people/${personId}/adjustments`),
    optional<HrLifecycle>(access.body.canManagePeople, `/hr/people/${personId}/lifecycle`),
    optional<HrVetting>(access.body.canManageVetting, `/hr/people/${personId}/vetting`),
    optional<HrCompetence>(access.body.canManageCompetence, `/hr/people/${personId}/competence`),
  ]);
  return <><p><Link href="/hr">Back to HR workspace</Link></p><h1>{person.body.displayName}</h1>
    <p className="secondary">Full HR record. Viewing restricted fields is audited.</p>
    <EmploymentSummary person={person.body} /><PrivateRecord person={person.body} />
    {leave && <LeaveRecord record={leave} />}{adjustments && <HealthRecord health={health} adjustments={adjustments} />}
    {lifecycle && <LifecycleRecord record={lifecycle} />}{vetting && <VettingRecord record={vetting} />}
    {competence && <CompetenceRecord record={competence} />}
    <HrPersonActions person={person.body} access={access.body} directory={directory.body.people}
      leave={leave} adjustments={adjustments} lifecycle={lifecycle} vetting={vetting} competence={competence} />
  </>;
}

async function optional<T>(allowed: boolean, path: `/${string}`): Promise<T | undefined> {
  if (!allowed) return undefined;
  const response = await apiGet<T>(path); if (!response.body) throw new Error(`Could not load ${path}`); return response.body;
}
