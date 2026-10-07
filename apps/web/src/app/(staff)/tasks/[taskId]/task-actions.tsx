'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { DateFields, TextField, dateFrom, optionalText } from '@/components/fields';
import type { Matter } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';
import { TASK_PRIORITY_LABELS, type Task, type TaskPriority } from '@/lib/tasks';

export function TaskActions({
  task,
  team,
  canChangeStatus,
}: {
  task: Task;
  team: Matter['team'];
  canChangeStatus: boolean;
}) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [done, setDone] = useState<string>();
  const [sending, setSending] = useState(false);
  const taskPath = `/api/tasks/${encodeURIComponent(task.id)}` as const;

  async function send(request: () => Promise<Response>, success: string) {
    setSending(true);
    setErrors(undefined);
    setDone(undefined);
    try {
      const response = await request();
      if (response.ok) {
        setDone(success);
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) {
      setErrors(['Enter a title for the task']);
      return;
    }
    void send(
      () =>
        fetch(taskPath, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: optionalText(form, 'description'),
            dueOn: dateFrom(form, 'dueOn'),
            priority: String(form.get('priority')),
          }),
        }),
      'Task details changed.',
    );
  }

  function reassign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const assigneeId = String(form.get('assigneeId'));
    const assignee = team.find((member) => member.accountId === assigneeId);
    void send(
      () =>
        fetch(`${taskPath}/assignee`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigneeId }),
        }),
      `Assigned to ${assignee?.displayName ?? 'the chosen colleague'}.`,
    );
  }

  function changeStatus(action: 'complete' | 'cancel' | 'reopen') {
    const past = action === 'complete' ? 'completed' : action === 'cancel' ? 'cancelled' : 'reopened';
    void send(() => postJson(`${taskPath}/${action}`, {}), `Task ${past}.`);
  }

  return (
    <>
      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{done && <p className="notice">{done}</p>}</div>

      <form onSubmit={edit} noValidate aria-labelledby="change-task-details-heading">
        <h2 id="change-task-details-heading">Change task details</h2>
        <TextField name="title" label="Title" defaultValue={task.title} />
        <div className="field">
          <label className="label" htmlFor="description">
            Description (optional)
          </label>
          <textarea className="input" id="description" name="description" rows={4} maxLength={2_000} defaultValue={task.description ?? ''} />
        </div>
        <DateFields name="dueOn" legend="Due date (optional)" hint="For example 15 2 2027" value={task.dueOn} />
        <div className="field">
          <label className="label" htmlFor="priority">
            Priority
          </label>
          <select className="select" id="priority" name="priority" defaultValue={task.priority}>
            {(Object.entries(TASK_PRIORITY_LABELS) as [TaskPriority, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button className="button" type="submit" disabled={sending}>
          Save changes
        </button>
      </form>

      <hr className="rule" />

      <form onSubmit={reassign} noValidate aria-labelledby="reassign-task-heading">
        <h2 id="reassign-task-heading">Reassign task</h2>
        <div className="field">
          <label className="label" htmlFor="assigneeId">
            Assignee
          </label>
          <select className="select" id="assigneeId" name="assigneeId" defaultValue={task.assignee.accountId}>
            {team.map((member) => (
              <option key={member.accountId} value={member.accountId}>
                {member.displayName}
              </option>
            ))}
          </select>
        </div>
        <button className="button button-secondary" type="submit" disabled={sending}>
          Reassign
        </button>
      </form>

      {canChangeStatus && (
        <>
          <hr className="rule" />
          <section aria-labelledby="change-task-status-heading">
            <h2 id="change-task-status-heading">Change status</h2>
            <div className="actions">
              {task.status === 'open' ? (
                <>
                  <button className="button" type="button" disabled={sending} onClick={() => changeStatus('complete')}>
                    Complete task
                  </button>
                  <button className="button button-warning" type="button" disabled={sending} onClick={() => changeStatus('cancel')}>
                    Cancel task
                  </button>
                </>
              ) : (
                <button className="button" type="button" disabled={sending} onClick={() => changeStatus('reopen')}>
                  Reopen task
                </button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
