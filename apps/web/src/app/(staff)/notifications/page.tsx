import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { NOTIFICATION_KIND_LABELS, type NotificationPage } from '@/lib/notifications';
import { TASK_STATUS_LABELS } from '@/lib/tasks';
import { MarkReadButton } from './mark-read-button';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const { status, body } = await apiGet<NotificationPage>('/notifications', {
    before: typeof before === 'string' ? before : undefined,
  });
  if (status === 400) {
    redirect('/notifications');
  }
  if (status === 401) {
    redirect('/sign-in');
  }
  if (status === 403) {
    redirect('/portal');
  }
  if (!body) {
    throw new Error('Could not load notifications');
  }

  return (
    <>
      <h1>Notifications</h1>
      {body.notifications.length === 0 ? (
        <p>You have no notifications.</p>
      ) : (
        <ul className="notification-list" aria-label="Notifications">
          {body.notifications.map((notification) => (
            <li key={notification.id} className={notification.readAt ? undefined : 'notification-unread'}>
              <span className="caption">{NOTIFICATION_KIND_LABELS[notification.kind]}</span>
              <h2>
                <Link href={`/tasks/${notification.task.id}`}>{notification.task.title}</Link>
              </h2>
              <p>
                {TASK_STATUS_LABELS[notification.task.status]} ·{' '}
                {notification.task.dueOn ? `Due ${formatCalendarDate(notification.task.dueOn)}` : 'No due date'}
              </p>
              <p className="secondary">
                {notification.readAt ? `Read ${formatDateTime(notification.readAt)}` : 'Unread'} · Received{' '}
                {formatDateTime(notification.createdAt)}
              </p>
              {!notification.readAt && <MarkReadButton notificationId={notification.id} />}
            </li>
          ))}
        </ul>
      )}
      {body.next && (
        <p>
          <Link href={`/notifications?before=${encodeURIComponent(body.next)}`}>Older notifications</Link>
        </p>
      )}
    </>
  );
}
