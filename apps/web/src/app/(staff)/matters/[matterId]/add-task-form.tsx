'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { DateFields, TextField, dateFrom, optionalText } from '@/components/fields';
import type { Matter } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';
import { TASK_PRIORITY_LABELS, type TaskPriority } from '@/lib/tasks';

export function AddTaskForm({ matterId, team }: { matterId: string; team: Matter['team'] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [added, setAdded] = useState<string>();
  const [sending, setSending] = useState(false);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = String(form.get('taskTitle') ?? '').trim();
    if (!title) {
      setErrors(['Enter a title for the task']);
      return;
    }

    setSending(true);
    setErrors(undefined);
    setAdded(undefined);
    try {
      const response = await postJson(`/api/matters/${encodeURIComponent(matterId)}/tasks`, {
        title,
        description: optionalText(form, 'description'),
        dueOn: dateFrom(form, 'dueOn'),
        priority: String(form.get('priority')),
        assigneeId: String(form.get('assigneeId')),
      });
      if (response.ok) {
        formElement.reset();
        setAdded(title);
        router.refresh();
        return;
      }
      setErrors(response.status === 400 ? ['Check the task details, including its title and due date'] : await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={add} noValidate aria-labelledby="add-task-heading">
      <h3 id="add-task-heading">Add a task</h3>
      {errors && <ErrorSummary messages={errors} />}
      {added && (
        <div role="status">
          <p className="notice">Added “{added}”.</p>
        </div>
      )}
      <TextField name="taskTitle" label="Task title" hint="For example: Prepare completion statement" />
      <div className="field">
        <label className="label" htmlFor="description">
          Description (optional)
        </label>
        <textarea className="input" id="description" name="description" rows={4} maxLength={2_000} />
      </div>
      <DateFields name="dueOn" legend="Due date (optional)" hint="For example 15 2 2027" />
      <div className="field">
        <label className="label" htmlFor="priority">
          Priority
        </label>
        <select className="select" id="priority" name="priority" defaultValue="normal">
          {(Object.entries(TASK_PRIORITY_LABELS) as [TaskPriority, string][]).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="label" htmlFor="assigneeId">
          Assignee
        </label>
        <select className="select" id="assigneeId" name="assigneeId">
          {team.map((member) => (
            <option key={member.accountId} value={member.accountId}>
              {member.displayName}
            </option>
          ))}
        </select>
      </div>
      <button className="button" type="submit" disabled={sending}>
        {sending ? 'Adding…' : 'Add task'}
      </button>
    </form>
  );
}
