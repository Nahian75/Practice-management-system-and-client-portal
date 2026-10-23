import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { HowTo } from '@/components/how-to';
import { ConflictResults } from '@/components/conflict-results';
import { MatterDetails } from '@/components/matter-details';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import type { DocumentSummary } from '@/lib/documents';
import type { ComplianceGate } from '@/lib/compliance';
import { formatCalendarDate, formatDate, formatDateTime } from '@/lib/format';
import { MATTER_STATUS_LABELS, type ComplianceAccess, type ConflictCheck, type Matter } from '@/lib/matters';
import type { Task } from '@/lib/tasks';
import type { AiDraftSummary, MatterAiMetrics } from '@/lib/ai';
import { ClearanceForm } from './clearance-form';
import { DocumentsSection } from './documents-section';
import { TasksSection } from './tasks-section';
import { FinanceSection } from './finance-section';
import { AiWorkbenchSection } from './ai-workbench-section';

export const metadata: Metadata = { title: 'Matter' };

export default async function MatterPage({
  params,
  searchParams,
}: {
  params: Promise<{ matterId: string }>;
  searchParams: Promise<{ documentsBefore?: string | string[]; tasksBefore?: string | string[] }>;
}) {
  const { matterId } = await params;
  const { documentsBefore, tasksBefore } = await searchParams;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body: matter } = await apiGet<Matter>(`/matters/${encodeURIComponent(matterId)}`);
  if (status === 403) {
    return <NoAccess what="matters" />;
  }
  if (status === 400) {
    notFound();
  }
  if (!matter) {
    // The same answer for a matter that does not exist and one the person is not on the team of.
    return (
      <>
        <h1>You cannot see this matter</h1>
        <p>Either there is no such matter, or you are not on its team. Its supervising partner can add you.</p>
      </>
    );
  }

  const check = await apiGet<ConflictCheck>(`/matters/${encodeURIComponent(matter.id)}/conflict-check`);
  const isSupervisor = matter.team.some((member) => member.accountId === account.id && member.role === 'supervising_partner');
  const accesses = isSupervisor
    ? await apiGet<{ accesses: ComplianceAccess[] }>(`/matters/${encodeURIComponent(matter.id)}/compliance-accesses`)
    : undefined;
  const closed = matter.status === 'closed';
  const [documents, tasks, amlGate, aiDrafts, aiMetrics] = await Promise.all([
    apiGet<{ documents: DocumentSummary[]; next: string | null }>(`/matters/${encodeURIComponent(matter.id)}/documents`, {
      before: typeof documentsBefore === 'string' ? documentsBefore : undefined,
    }),
    apiGet<{ tasks: Task[]; next: string | null }>(`/matters/${encodeURIComponent(matter.id)}/tasks`, {
      before: typeof tasksBefore === 'string' ? tasksBefore : undefined,
    }),
    apiGet<ComplianceGate>(`/matters/${encodeURIComponent(matter.id)}/aml-gate`),
    apiGet<{ drafts: AiDraftSummary[] }>(`/matters/${encodeURIComponent(matter.id)}/ai/drafts`),
    apiGet<MatterAiMetrics>(`/matters/${encodeURIComponent(matter.id)}/ai/metrics`),
  ]);

  return (
    <>
      <span className="caption">
        {matter.reference} · {MATTER_STATUS_LABELS[matter.status]}
      </span>
      <h1>{matter.title}</h1>
      <HowTo>
        <li>Check &ldquo;Compliance clearance&rdquo; first. Some work is blocked until the matter is cleared.</li>
        <li>Use &ldquo;Add a document&rdquo; to upload a file. Open a document to share it with the client.</li>
        <li>Use &ldquo;Add a task&rdquo; to give work to someone on the team, with a due date.</li>
        <li>Use &ldquo;Record time&rdquo; to log the time you spent, so it can be billed.</li>
      </HowTo>
      {!closed && (
        <div className="actions">
          <Link href={`/matters/${matter.id}/edit`}>Change details</Link>
          {isSupervisor && <Link href={`/matters/${matter.id}/team`}>Change the team</Link>}
          {isSupervisor && <Link href={`/matters/${matter.id}/close`}>Close the matter</Link>}
        </div>
      )}

      {matter.status === 'awaiting_clearance' && (
        <div className="notice">
          <p>
            <strong>Awaiting conflict clearance.</strong> The conflict check found possible conflicts. No work should start
            until the supervising partner has recorded why they are not a conflict.
          </p>
        </div>
      )}
      {closed && (
        <div className="notice">
          <p>
            <strong>This matter is closed.</strong> It can no longer be changed.
          </p>
        </div>
      )}

      <MatterDetails matter={matter} />

      {amlGate.body && <section aria-labelledby="aml-heading"><h2 id="aml-heading">Compliance clearance</h2>
        <div className={`notice ${amlGate.body.state === 'cleared' ? '' : 'notice-warning'}`}><p><strong>{amlState(amlGate.body.state)}.</strong>{' '}
          {amlGate.body.dueSince ? `Review due since ${formatCalendarDate(amlGate.body.dueSince)}.` : ''}
          {amlGate.body.workAllowedUntil ? ` Existing work may continue until ${formatCalendarDate(amlGate.body.workAllowedUntil)}.` : ''}</p></div>
        <p><Link href={`/matters/${matter.id}/compliance`}>Open matter AML assessment</Link></p>
      </section>}

      <TasksSection matter={matter} tasks={tasks.body?.tasks} next={tasks.body?.next ?? null} />

      <AiWorkbenchSection
        matterId={matter.id}
        documents={documents.body?.documents}
        initialDrafts={aiDrafts.body?.drafts}
        metrics={aiMetrics.body}
        canUseAi={!closed && aiDrafts.status !== 403}
      />

      <DocumentsSection
        matterId={matter.id}
        documents={documents.body?.documents}
        next={documents.body?.next ?? null}
        canAdd={matter.status === 'open'}
      />

      <FinanceSection matter={matter} />

      <h2>Conflict check</h2>
      {check.body ? (
        <>
          <p className="secondary">Run on {formatDate(check.body.createdAt)}.</p>
          <ConflictResults check={check.body} />
          {check.body.clearance && (
            <dl className="summary">
              <div className="summary-row">
                <dt>Cleared by</dt>
                <dd>
                  {check.body.clearance.clearedBy.displayName}, {formatDate(check.body.clearance.clearedAt)}
                </dd>
              </div>
              <div className="summary-row">
                <dt>Why it is not a conflict</dt>
                <dd>{check.body.clearance.reason}</dd>
              </div>
            </dl>
          )}
        </>
      ) : (
        <p>The conflict check could not be loaded. Reload the page to try again.</p>
      )}

      {matter.status === 'awaiting_clearance' && isSupervisor && <ClearanceForm matterId={matter.id} />}

      {accesses?.body && (
        <>
          <h2>Compliance accesses</h2>
          {accesses.body.accesses.length === 0 ? (
            <p>Nobody from compliance has looked at this matter.</p>
          ) : (
            <table className="table">
              <caption className="secondary">Shown to you as supervising partner. You are also emailed each time.</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {accesses.body.accesses.map((access) => (
                  <tr key={access.id}>
                    <td>{formatDateTime(access.accessedAt)}</td>
                    <td>{access.accessedBy.displayName}</td>
                    <td>{access.document ? <>Downloaded &ldquo;{access.document.title}&rdquo;, version {access.document.version}</> : 'Opened the matter'}</td>
                    <td>{access.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function amlState(state: ComplianceGate['state']) {
  return ({ pending: 'Compliance work pending', cleared: 'Compliance cleared', review_due: 'Compliance review due', held: 'Contact Compliance' } as const)[state];
}
