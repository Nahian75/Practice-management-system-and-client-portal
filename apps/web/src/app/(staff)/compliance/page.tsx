import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import type { ComplianceAccess, ComplianceHold, RetentionScheduleSummary, ReviewQueueItem,
  SanctionsCandidate, SanctionsStatus } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { ClientSummary } from '@/lib/clients';
import { ComplianceOperations } from './compliance-operations';

export const metadata: Metadata = { title: 'Compliance' };

export default async function CompliancePage() {
  const access = await apiGet<ComplianceAccess>('/compliance/access');
  if (access.status === 403 || !access.body) return <NoAccess what="the Compliance workspace" />;
  const [reviews, holds, sanctions, candidates, retention, clients] = await Promise.all([
    apiGet<{ matters: ReviewQueueItem[]; next: string | null }>('/compliance/reviews'),
    apiGet<{ holds: ComplianceHold[]; next: string | null }>('/compliance/holds'),
    apiGet<SanctionsStatus>('/compliance/sanctions/status'),
    apiGet<{ candidates: SanctionsCandidate[]; next: string | null }>('/compliance/sanctions/candidates'),
    apiGet<{ schedules: RetentionScheduleSummary[] }>('/compliance/retention'),
    apiGet<{ clients: ClientSummary[] }>('/compliance/clients'),
  ]);
  if (!reviews.body || !holds.body || !sanctions.body || !candidates.body || !retention.body || !clients.body) {
    throw new Error('Could not load the Compliance workspace');
  }
  const dueRetention = retention.body.schedules.filter((item) => item.disposeAfter <= new Date().toISOString().slice(0, 10)
    && item.currentHold?.action !== 'imposed' && item.currentHold?.action !== 'reviewed');

  return <>
    <h1>Compliance</h1>
    <p className="secondary">Firm-wide AML and sanctions work. Stass records evidence and decisions; it does not make a legal or reporting decision.</p>
    <nav aria-label="Compliance sections" className="section-nav"><ul>
      <li><Link href="/policies">Firm policies</Link></li>
      <li><Link href="/compliance/retention">Retention and disposal</Link></li>
      <li><Link href="/compliance/exports">Regulatory exports</Link></li>
      {access.body.canRestricted && <li><Link href="/compliance/restricted-reports">Nominated-officer records</Link></li>}
    </ul></nav>
    <ComplianceOperations candidates={candidates.body.candidates} holds={holds.body.holds} clients={clients.body.clients} />

    <section aria-labelledby="sanctions-heading"><h2 id="sanctions-heading">Sanctions list</h2>
      <div className={`notice ${sanctions.body.fresh ? '' : 'notice-warning'}`}><p><strong>{sanctions.body.fresh ? 'Current' : 'Action required'}.</strong>{' '}
        {sanctions.body.reportDate ? `List report dated ${formatCalendarDate(sanctions.body.reportDate)}.` : 'No active UK Sanctions List.'}
        {sanctions.body.lastFailureAt ? ` Last failed refresh: ${formatDateTime(sanctions.body.lastFailureAt)}.` : ''}</p></div>
      {!candidates.body.candidates.length ? <p>No unresolved screening candidates.</p> : <table className="table">
        <caption className="secondary">Unresolved candidates need a human identity and ownership/control review.</caption>
        <thead><tr><th scope="col">Client</th><th scope="col">Matched name</th><th scope="col">Birth data</th><th scope="col">Screened</th></tr></thead>
        <tbody>{candidates.body.candidates.map((item) => <tr key={item.candidateId}><td><Link href={`/clients/${item.clientId}`}>{item.clientReference}</Link></td>
          <td>{item.matchedName}</td><td>{item.birthAgreement}</td><td>{formatDateTime(item.screenedAt)}</td></tr>)}</tbody>
      </table>}
    </section>

    <section aria-labelledby="reviews-heading"><h2 id="reviews-heading">Matter reviews</h2>
      {!reviews.body.matters.length ? <p>No pending, held or due matter reviews.</p> : <table className="table"><thead><tr><th scope="col">Matter</th><th scope="col">State</th><th scope="col">Review due</th><th scope="col">Work allowed until</th></tr></thead>
        <tbody>{reviews.body.matters.map((item) => <tr key={item.matterId}><td><Link href={`/matters/${item.matterId}/compliance`}>{item.reference}</Link></td>
          <td>{stateLabel(item.state)}</td><td>{item.reviewDueOn ? formatCalendarDate(item.reviewDueOn) : 'Not set'}</td>
          <td>{item.workAllowedUntil ? formatCalendarDate(item.workAllowedUntil) : 'Not applicable'}</td></tr>)}</tbody></table>}
    </section>

    <section aria-labelledby="holds-heading"><h2 id="holds-heading">Active operational holds</h2>
      {!holds.body.holds.length ? <p>No active holds.</p> : <table className="table"><thead><tr><th scope="col">Record</th><th scope="col">Reason</th><th scope="col">Imposed</th></tr></thead>
        <tbody>{holds.body.holds.map((hold) => <tr key={hold.id}><td>{hold.matterId ? <Link href={`/matters/${hold.matterId}`}>Matter</Link> : <Link href={`/clients/${hold.clientId}`}>Client</Link>}</td>
          <td>{hold.reason}</td><td>{formatDateTime(hold.imposedAt)}</td></tr>)}</tbody></table>}
    </section>

    <section aria-labelledby="retention-heading"><h2 id="retention-heading">Retention</h2>
      <p>{retention.body.schedules.length} active schedule{retention.body.schedules.length === 1 ? '' : 's'}; {dueRetention.length} eligible by date and not under a legal hold.</p>
      <p><Link href="/compliance/retention">Open retention and disposal</Link></p>
    </section>
  </>;
}

function stateLabel(state: ReviewQueueItem['state']) {
  return ({ pending: 'Pending', cleared: 'Cleared', review_due: 'Review due', held: 'Held' } as const)[state];
}
