# Security review: notifications module

**Date:** 2026-10-08
**Scope:** the encrypted email outbox, staff task notifications, reminder
scheduler, notification API and staff inbox (`apps/api/src/mail/`,
`apps/api/src/notifications/`, migrations `0035` to `0040`, and the
notification parts of `apps/web`). The module was delivered in commits
`4290ffa` to `f241579`.
**Method:** database functions, grants and triggers; encryption context;
delivery state and final checks; API queries, response schemas and staff/client
screens read. Each confirmed finding was reproduced by a failing regression
before its fix; every new safeguard was then broken on purpose and restored.
The production dependency tree was checked from npm's local advisory cache
(`npm audit --offline --omit=dev`: no cached finding). No online advisory query
was made because that would send the dependency list to npm.

## Findings

### N1 - The reminder function accepts a future processing date

| | |
|---|---|
| Severity | **Low** |
| Location | `create_task_reminders_through` (migration `0040`) |
| Problem | The scheduler supplied the current London date, but the database function accepted any date from the application role. A mistaken or hostile direct caller could move the processing window into the future. |
| Impact | **Probe:** a call with tomorrow's London date was accepted and selected a task's seven-day reminder one day early. This could create early inbox notices and generic emails. It exposed no task or client text in email, and unique keys prevented duplicates, but it changed the promised work schedule. |
| Fix | **Fixed after the review** (migration `0041`). PostgreSQL now compares the requested date with its own current `Europe/London` date and rejects a future value before taking the batch lock or inserting anything. |
| Test | `task-reminders.migration.exclusive.spec.ts` asks for tomorrow while a matching task exists and expects refusal. Removing the database comparison made the test fail. |

### N2 - A task email does not recheck its decrypted recipient address

| | |
|---|---|
| Severity | **Low** |
| Location | `MailOutbox.deliver`, `MailOutboxRepository.taskEmailIsCurrent` |
| Problem | The final task-mail check matched the account id, task, assignment, status, membership and due date, but it ran before decryption and did not compare the envelope's address with the current account row. The existing application cannot change an account's address and the queueing service used the correct address, but the worker did not enforce that relationship itself. |
| Impact | **Probe:** the final policy accepted an otherwise current task email when given a different mailbox. An incorrectly constructed encrypted row could therefore send the generic task notice to the wrong address. The message still contained no client or task detail and its link still required a valid two-factor session with current task access. |
| Fix | **Fixed after the review.** The worker decrypts and validates the payload first, passes its recipient to the final policy, and sends only when that address equals the active assignee account's address. |
| Test | `mail-outbox.spec.ts` proves the worker passes the decrypted address; `task-reminders.integration.spec.ts` refuses a different address. Omitting either the passed value or the database address filter made its matching test fail. |

### N3 - Accepted behaviour and later work

| | |
|---|---|
| Severity | **Information** |
| Items | **SMTP acknowledgement is not transactional with PostgreSQL.** A crash after the provider accepts a message can produce a duplicate; the documented delivery promise is at least once. **An access change can race the final check and SMTP send.** Task email is deliberately generic, has no token and the linked API rechecks access. **The application database role operates the queue.** Its narrowly granted claim and finish functions can necessarily suppress or complete delivery; a separate worker credential would give more containment if the deployment threat model later requires it. **General request and download limiting** remains deployment work F2; notification routes still require a live two-factor staff session. |

## Checked and in order

- **Recipients and visibility:** staff routes reject client and missing
  sessions. Lists and reads require the named recipient and current matter
  membership; losing access removes the item without deleting its record.
- **Database records:** notification identity and times are database-owned;
  notification, read and outbox-change histories are insert-only; queue state
  moves only through leased functions; owner deletion and truncation are
  refused. Duplicate keys remain database-enforced.
- **Mail privacy:** recipient, subject and body remain AES-256-GCM encrypted;
  account and resource metadata is authenticated; terminal rows clear their
  encrypted payload. Task mail contains only generic words and an ordinary
  signed-in URL. Logs, audit and safe failure classes contain no address,
  message, task or client text.
- **Live delivery checks:** expired links and rows are not sent. Task mail is
  suppressed after address, due-date, assignee, task/matter status, team or
  account changes. PostgreSQL now bounds reminder catch-up to its London date.
- **Concurrency and recovery:** advisory locking and unique keys serialise
  reminder creation; row leases and `SKIP LOCKED` coordinate workers; retries
  are bounded and terminal payload removal is permanent.
- **Input and output:** strict request and response schemas limit notification
  fields; React renders current task text as text; private descriptions,
  matter names and client data are absent from the inbox response and screen.
- **Audit:** creation and reading share their business transaction with audit;
  delivery outcomes are recorded in the same transaction as the final queue
  change. Audit metadata contains identifiers and states only.
- **Dependencies:** the review added no dependency. The offline production
  advisory check found no cached vulnerability.
