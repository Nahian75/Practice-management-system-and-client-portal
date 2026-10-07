import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { Matter } from '@/lib/matters';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, type TaskChange, type TaskDetails } from '@/lib/tasks';
import { TaskActions } from './task-actions';

export const metadata: Metadata = { title: 'Task' };

export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body: task } = await apiGet<TaskDetails>(`/tasks/${encodeURIComponent(taskId)}`);
  if (status === 403) {
    return <NoAccess what="tasks" />;
  }
  if (status === 400) {
    notFound();
  }
  if (!task) {
    return <HiddenTask />;
  }

  const { body: matter } = await apiGet<Matter>(`/matters/${encodeURIComponent(task.matterId)}`);
  if (!matter) {
    return <HiddenTask />;
  }
  const isSupervisor = matter.team.some((member) => member.accountId === account.id && member.role === 'supervising_partner');
  const canChangeStatus = matter.status === 'open' && (task.assignee.accountId === account.id || isSupervisor);

  return (
    <>
      <p>
        <Link href={`/matters/${matter.id}`}>
          Back to {matter.title} ({matter.reference})
        </Link>
      </p>
      <span className="caption">
        {TASK_STATUS_LABELS[task.status]} · {TASK_PRIORITY_LABELS[task.priority]} priority
      </span>
      <h1>{task.title}</h1>

      {matter.status === 'closed' && (
        <div className="notice">
          <p>
            <strong>This matter is closed.</strong> The task and its history are kept, but cannot be changed.
          </p>
        </div>
      )}

      <dl className="summary">
        <div className="summary-row">
          <dt>Status</dt>
          <dd>{TASK_STATUS_LABELS[task.status]}</dd>
        </div>
        <div className="summary-row">
          <dt>Description</dt>
          <dd>{task.description ?? 'None'}</dd>
        </div>
        <div className="summary-row">
          <dt>Due date</dt>
          <dd>{task.dueOn ? formatCalendarDate(task.dueOn) : 'No due date'}</dd>
        </div>
        <div className="summary-row">
          <dt>Priority</dt>
          <dd>{TASK_PRIORITY_LABELS[task.priority]}</dd>
        </div>
        <div className="summary-row">
          <dt>Assignee</dt>
          <dd>{task.assignee.displayName}</dd>
        </div>
        <div className="summary-row">
          <dt>Created by</dt>
          <dd>{task.createdBy.displayName}</dd>
        </div>
        <div className="summary-row">
          <dt>Created</dt>
          <dd>{formatDateTime(task.createdAt)}</dd>
        </div>
      </dl>

      <h2>History</h2>
      {task.changes.length === 0 ? <p>No changes yet.</p> : <TaskHistory changes={task.changes} />}

      {matter.status === 'open' && (
        <>
          <hr className="rule" />
          <TaskActions task={task} team={matter.team} canChangeStatus={canChangeStatus} />
        </>
      )}
    </>
  );
}

function HiddenTask() {
  return (
    <>
      <h1>You cannot see this task</h1>
      <p>Either there is no such task, or you are not on its matter&rsquo;s team.</p>
    </>
  );
}

function TaskHistory({ changes }: { changes: TaskChange[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Change</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
          <th scope="col">Changed by</th>
          <th scope="col">When</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => {
          const values = historyValues(change);
          return (
            <tr key={change.id}>
              <td>{values.label}</td>
              <td>{values.before}</td>
              <td>{values.after}</td>
              <td>{change.changedBy.displayName}</td>
              <td>{formatDateTime(change.changedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function historyValues(change: TaskChange): { label: string; before: string; after: string } {
  switch (change.kind) {
    case 'details':
      return { label: 'Details', before: snapshot(change.from), after: snapshot(change.to) };
    case 'assignment':
      return { label: 'Assignee', before: change.from.displayName, after: change.to.displayName };
    case 'status':
      return { label: 'Status', before: TASK_STATUS_LABELS[change.from], after: TASK_STATUS_LABELS[change.to] };
  }
}

function snapshot(value: { title: string; description: string | null; dueOn: string | null; priority: keyof typeof TASK_PRIORITY_LABELS }): string {
  return [
    `Title: ${value.title}`,
    `Description: ${value.description ?? 'None'}`,
    `Due: ${value.dueOn ? formatCalendarDate(value.dueOn) : 'No due date'}`,
    `Priority: ${TASK_PRIORITY_LABELS[value.priority]}`,
  ].join('; ');
}
