# Notifications

**Current state (2026-10-07):** First-version design approved by the project
owner. Step 13a is not started.

How Stass tells staff about work that needs their attention, without putting
client information into email or losing messages when the API restarts.

## Already decided

| Topic | Decision | Source |
|---|---|---|
| Task reminders | Automatic reminders and email belong here, not in Tasks | [tasks.md](tasks.md) |
| Email transport | Plain-text SMTP over verified TLS; Mailpit locally | [integrations.md](integrations.md) |
| Delivery reliability | The in-memory mail queue must become persistent before production | Authentication review F5 |
| Sensitive content | Passwords, tokens, client information and message bodies are never logged | [security.md](security.md) |
| Client tasks | Tasks and their descriptions are internal and never shown in the client portal | [tasks.md](tasks.md) |
| Dates | Task due dates are calendar dates and cannot move through a time zone | [tasks.md](tasks.md) |

## Decisions

| Topic | Decision | Why |
|---|---|---|
| First recipients | Staff only. Client notifications are a later portal design | Keeps internal task information out of the client boundary |
| Channels | An in-app inbox for staff; email only for assignments and due-date reminders | Gives a durable place to look without emailing every small change |
| Assignment notices | Tell the new assignee immediately. Tell the old assignee in the inbox when work is reassigned away | Both people can see that responsibility changed |
| Status notices | In-app only, and only when someone else completes, cancels or reopens a task assigned to you | Avoids telling someone about their own action and avoids email noise |
| Reminder schedule | At 09:00 Europe/London: 7 calendar days before, 1 day before, and on the due date. One overdue notice the next day; no daily repeat | Useful warning without an endless stream. Calendar days match the stored due date and need no bank-holiday service |
| Email content | Generic subject and body: no client name, matter title/reference, task title, description or due date. A link opens the task after sign-in and the API rechecks access | Email can be forwarded, shown on a lock screen or retained outside Stass |
| Preferences | No opt-out in the first version. These are work-allocation notices; channel preferences can be designed later | Prevents silent missed work while the legal process is still being established |
| Read state | A notification may be marked read once. It is never deleted or made unread; access to its task is still rechecked whenever it is listed or opened | Keeps an answerable record without preserving a route around matter access |
| Delivery guarantee | At least once. A crash after SMTP accepts a message but before Stass records success can cause a duplicate, never a silent loss | SMTP provides no transaction shared with PostgreSQL |
| Retention | Keep notification metadata. Remove encrypted email payloads after successful delivery or final expiry; keep only delivery outcome, attempts and times | One-time links and message bodies should not become permanent records |

## Security and privacy rules

- Notification rows store ids and kinds, never copied task titles,
  descriptions, client names or matter titles.
- The staff inbox query joins through the task and current active matter-team
  membership. Losing matter access removes the notification from the next
  response even though its record remains.
- A task email is queued only for the current active assignee. The worker
  rechecks the account, membership, assignment, task status and due date just
  before sending. A reassignment, completion, cancellation, team removal or
  account disable therefore suppresses a stale reminder.
- Emails contain a normal Stass task URL, never an access token. A recipient
  must sign in with two factors and still pass the task API's 404 rule.
- Email address, subject and body are encrypted in the outbox with AES-256-GCM
  under a key outside PostgreSQL. Logs contain only the outbox id, kind,
  attempt number and outcome.
- The database controls notification identity and time, the allowed kinds,
  recipient kind, one-way read state and the outbox state machine. The
  application cannot rewrite recipients or resource ids after insertion.
- Duplicate keys are database-enforced. Retrying a request or running several
  schedulers cannot create the same assignment notice or the same reminder
  for one task, due date and reminder point.
- Client sessions cannot call staff notification routes. Holding a staff role
  alone does not reveal a task notification after matter membership ends.

## Records

### `notifications`

- `id`, set by PostgreSQL.
- `recipient_id`, a staff account, fixed.
- `kind`: `task_assigned`, `task_unassigned`, `task_completed`,
  `task_cancelled`, `task_reopened`, `task_due_soon`, `task_due_today` or
  `task_overdue`.
- `task_id`, fixed. Matter and current display text are read through the task,
  never copied into the notification.
- `deduplication_key`, derived from stable ids, event and, for reminders, the
  due date and reminder point; unique.
- `created_at`, set by PostgreSQL.
- `read_at`, nullable and set once by the recipient.

Rows are insert-only apart from the first `read_at`. They cannot be deleted or
truncated, including by the table owner.

### `email_outbox`

One durable queue for existing authentication/security email and notification
email:

- database-set id and queue time;
- message kind and optional recipient account/resource ids, with a unique
  deduplication key where the caller has one;
- key version, nonce, encrypted payload and authentication tag;
- `not_before`, attempt count, a short lease and next-attempt time;
- sent, discarded or finally-failed outcome and time;
- a safe failure class only, never the provider's message if it may contain an
  address or message content.

The payload is the exact recipient, subject and plain-text body. It is cleared
after success, discard or final expiry. The database permits only forward
state changes. Queue workers claim due rows with `FOR UPDATE SKIP LOCKED`, so
several API instances do not normally send the same row. A lease lets another
worker retry after a crash.

Retries use bounded exponential delays. A malformed message is failed without
retry. Temporary SMTP/network failures retry; after the final limit of 24
hours, the row is marked failed and administrators receive one separate
generic notice through the inbox. No failed payload is logged.

## Reminder scheduler

- Runs safely on every API instance; a PostgreSQL advisory lock lets only one
  scheduler create a given batch.
- Reads due calendar dates relative to `Europe/London`, including the clock
  changes between GMT and British Summer Time.
- Creates notification/outbox rows in one transaction. Unique keys make a
  repeated or overlapping run harmless.
- Uses the database clock for queue and outcome times. Tests use the existing
  injected clock for deciding which due-date window is being processed.
- Startup processes any reminder point missed while Stass was stopped. The
  unique key prevents resending a point that was already recorded.

## API and screens

| Method | Path | Rule | Result |
|---|---|---|---|
| GET | `/notifications` | Signed-in staff; current task visibility rechecked | 50 newest visible notifications and `next`; unread count included |
| POST | `/notifications/:id/read` | The named recipient and still able to see the task | 204; repeating is harmless |

The staff header shows an unread count and links to `/notifications`. The page
lists safe current task text only after the API has rechecked access. Each item
links to the task. There is no client navigation or portal route.

## Audit

- `notification.created`: recipient id, kind, task id.
- `notification.read`: notification id and task id.
- `email.queued`, `email.sent`, `email.discarded`, `email.failed`: outbox id and
  message kind, with account/resource ids where safe.

No address, subject, body, task text, client data or provider error text goes
into audit metadata. Queue creation shares the transaction with the business
event where practical. Delivery outcomes are separate worker transactions.

## Not in the first version

- Client email or portal notifications.
- SMS, push notifications, Teams, Slack or calendar integration.
- User-chosen schedules, digests or channel preferences.
- Bank-holiday or personal-working-day calendars.
- General announcements unrelated to a record.

## Build order

Each implementation step ships with positive and negative tests, deliberate
breaks of every safeguard and updated documentation before the next.

- **13a.** Persistent encrypted email outbox, worker, retries and migration of
  every existing background email caller; closes review item F5. No task
  notifications yet.
- **13b.** Insert-only staff notification records; task assignment and status
  events; list/read API with current matter access rechecked.
- **13c.** Due-date scheduler, deduplicated reminders and generic task email.
- **13d.** Staff notification header and inbox screens.
- Security review of Notifications.

## Approval

The project owner approved this design on 7 October 2026, including the
channels, four reminder points, no opt-out, generic email content, 24-hour
retry period and at-least-once delivery.
