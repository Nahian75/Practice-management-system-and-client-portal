# Notifications

**Current state (2026-10-12):** First-version design approved by the project
owner. Steps 13a to 13d are built, tested and security-reviewed. Review items
N1 and N2 are fixed in migration `0041` and the mail worker. Compliance step
15f adds a separate content-free navigation count; it does not create ordinary
notification or email rows.

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
  decrypts it, then rechecks the recipient address, account, membership,
  assignment, task status and due date just before sending. An address
  mismatch, reassignment, completion, cancellation, team removal or account
  disable therefore suppresses a stale reminder.
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
- The Compliance navigation count is computed on request and names no client,
  matter or event. It counts only ordinary sanctions candidates, non-restricted
  holds, due retention and stale sanctions data. Restricted reports and holds
  linked to them never enter this count, the inbox or the email outbox.

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
worker retry after a crash. Each API instance runs only one drain loop at a
time. On shutdown it finishes any row it has claimed, but does not wait for a
lease held by another instance.

Retries use bounded exponential delays. A malformed message is failed without
retry. Temporary SMTP/network failures retry; after the final limit of 24
hours, the row is marked failed and administrators receive one separate
generic notice through the inbox. No failed payload is logged.

Step 13a uses delays of 1 minute, 5 minutes, 30 minutes, 2 hours and then at
most 6 hours between attempts. `email.failed` remains the durable record of a
final delivery failure. A generic administrator inbox alert needs a separate
later design: step 13b deliberately stores only task-linked kinds and cannot
truthfully attach an email failure to a task.

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
- The database refuses a catch-up date after its own current Europe/London
  date. A caller cannot move the reminder window into the future.
- Catch-up starts on the London calendar date when migration `0038` is first
  installed. That database-owned date cannot be changed or removed, so the
  first run cannot send reminders for the time before this feature existed.
- Automatic scheduler startup is disabled only under `NODE_ENV=test`, where
  several application instances share one test database. The service and its
  production startup path are tested directly.

## API and screens

| Method | Path | Rule | Result |
|---|---|---|---|
| GET | `/notifications` | Signed-in staff; current task visibility rechecked | 50 newest visible notifications and `next`; unread count included |
| POST | `/notifications/:id/read` | The named recipient and still able to see the task | 204; repeating is harmless |

Each list item contains the notification id, kind, creation and optional read
times, plus the task's current id, title, status and due date. `next` is the
last notification id when a full page is returned. Text is read from the
current task only after access has been checked; it is not stored in the
notification record.

The staff header shows an unread count and links to `/notifications`. The page
lists safe current task text only after the API has rechecked access. Each item
links to the task and shows its current status and due date. Unread items can
be marked read once. The page shows 50 newest records at a time and links to
older records when there are more. There is no client navigation or portal
route; a client who enters `/notifications` is sent back to `/portal`.

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

- **13a. Done.** Persistent encrypted email outbox, worker, retries and
  migration of every existing background email caller; closes review item F5.
  No task notifications yet. Migrations `0035` and `0036`; implementation in
  `apps/api/src/mail/`.
- **13b. Done.** Insert-only staff notification and read records; database-
  created task assignment and status events; transactional audit; list/read
  API with recipient and current matter access rechecked. Migration `0037`;
  implementation in `apps/api/src/notifications/` and the Tasks service.
- **13c. Done.** Assignment email, the 09:00 Europe/London due-date scheduler,
  startup catch-up, database-deduplicated reminders and last-moment delivery
  checks. Migrations `0038` to `0040`; implementation in
  `apps/api/src/notifications/` and the mail worker.
- **13d. Done.** Staff header unread count and `/notifications` inbox with
  current task facts, read action and 50-row paging. Implementation in
  `apps/web/src/app/(staff)/notifications/` and the shared staff layout.
- **Security review done.** Two low-severity findings fixed: future reminder
  windows are refused by migration `0041`, and task email must still name the
  account's current address immediately before delivery
  ([review](reviews/2026-10-08-notifications.md)).

## Approval

The project owner approved this design on 7 October 2026, including the
channels, four reminder points, no opt-out, generic email content, 24-hour
retry period and at-least-once delivery.

## Step 13a verification

- Positive tests cover encrypted storage, restart delivery, deduplication,
  leases, concurrent workers, retries, terminal payload clearing and all
  existing invitation, reset and security-notice callers.
- Negative tests cover malformed and corrupted payloads, expired links,
  final expiry, wrong leases, unknown kinds, caller-supplied state, direct
  edits, deletion and truncation, unsafe audit/log content and immutable
  transition history.
- Fifteen deliberate break cases were run and restored. They proved the
  tests catch readable payload storage, missing authenticated account binding,
  sending stale or expired mail, provider text in logs, addresses in audit,
  lost retries, retrying corrupt ciphertext, caller-controlled database
  values, mutable queue rows, bypassed lease transitions, mutable transition
  history, non-idempotent duplicate handling, overlapping drain loops and a
  shutdown stuck waiting for another worker's lease.

## Step 13b verification

- Positive tests cover assignment, reassignment, completion, cancellation and
  reopening notices; suppression of self-made and no-op status changes;
  current task text; newest-first 50-row paging; unread counts; one-way,
  repeat-safe reading; and creation/read audit records containing ids only.
- Negative tests cover client and missing sessions, a different staff
  recipient, lost matter access, disabled accounts, invalid input, invalid
  kinds and recipients, caller-supplied trusted values, duplicate keys,
  direct writes, owner edits, deletion and truncation, and transaction
  rollback when audit fails.
- Fifteen deliberate break cases were run and restored. They proved the tests
  catch missing task-insert and task-change notification triggers, missing
  database preparation, mutable notification and read records, bypassed read
  validation, excess application-role insert rights, missing truncation
  guards, missing deduplication, missing live-access and recipient filters,
  a missing staff route boundary, and missing creation or read audit.

## Step 13c verification

- Positive tests cover generic assignment email, all four reminder points,
  repeat-safe and missed-day catch-up, GMT and British Summer Time scheduling,
  production startup catch-up, encrypted reminder email, transactionally
  matched notification/email audit records and the single database batch lock.
- Negative tests cover tasks without dates, completed and cancelled tasks,
  removed team members, disabled accounts, private task/client text in email,
  immutable scheduler settings, audit rollback, malformed task-mail identity,
  and stale email after a due-date, assignee, status, membership or account
  change.
- Sixteen deliberate break cases were run and restored. They proved the
  tests catch UTC scheduling, skipped startup catch-up, missing assignment or
  reminder email, private text in email, missing reminder audit, a bypassed
  final worker check, and missing due-date, assignee, status, membership or
  account checks. Separate database breaks proved the owner edit and truncate
  guards, unique de-duplication constraint and advisory batch lock.

## Step 13d verification

- Browser tests cover the header count, current task title/status/due date,
  generic event wording, one-way read action, task navigation, empty state,
  newest-first 50-row paging and the older-page link. Axe checks the inbox.
- Negative browser tests prove task descriptions and matter titles are absent,
  notifications disappear immediately after matter access ends, and client
  accounts have neither notification navigation nor a usable staff route.
- Seven deliberate break cases were run and restored. They proved the tests
  catch a false unread count, private content in an item, stale text after
  access loss, a read request for the wrong notification, a dropped page
  cursor, an unhandled invalid cursor and a missing client-to-portal redirect.

## Security review verification

- Database and integration tests refuse a future London catch-up date and a
  task email whose decrypted address does not match the current account.
- Three deliberate breaks were run and restored. They proved the tests catch
  a missing future-date guard, a missing recipient-address database filter and
  a worker that fails to pass the decrypted address into its final check.
- The production dependency tree was checked from npm's local advisory cache;
  no cached vulnerability was found.
