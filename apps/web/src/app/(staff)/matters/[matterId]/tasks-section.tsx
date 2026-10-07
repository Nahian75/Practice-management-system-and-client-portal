import Link from 'next/link';
import { formatCalendarDate } from '@/lib/format';
import type { Matter } from '@/lib/matters';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, type Task } from '@/lib/tasks';
import { AddTaskForm } from './add-task-form';

/** The matter's tasks, newest first, and creation while the matter is open. */
export function TasksSection({
  matter,
  tasks,
  next,
}: {
  matter: Matter;
  tasks: Task[] | undefined;
  next: string | null;
}) {
  return (
    <section aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">Tasks</h2>
      {tasks === undefined ? (
        <p>The tasks could not be loaded. Reload the page to try again.</p>
      ) : tasks.length === 0 ? (
        <p>No tasks yet.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first. Completed and cancelled tasks stay in the matter record.</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Status</th>
              <th scope="col">Priority</th>
              <th scope="col">Due</th>
              <th scope="col">Assignee</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <Link href={`/tasks/${task.id}`}>{task.title}</Link>
                </td>
                <td>{TASK_STATUS_LABELS[task.status]}</td>
                <td>{TASK_PRIORITY_LABELS[task.priority]}</td>
                <td>{task.dueOn ? formatCalendarDate(task.dueOn) : 'No due date'}</td>
                <td>{task.assignee.displayName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <p>
          <Link href={`/matters/${matter.id}?tasksBefore=${encodeURIComponent(next)}`}>Older tasks</Link>
        </p>
      )}
      {matter.status === 'open' && <AddTaskForm matterId={matter.id} team={matter.team} />}
    </section>
  );
}
