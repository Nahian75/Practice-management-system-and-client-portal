# Tasks

**Current state (2026-10-07):** Steps 12a to 12c are built and
security-reviewed: the database foundation and insert-only history
(migrations `0029` to `0034`), all three task permissions, the complete staff
API (`apps/api/src/tasks/`), and the matter and task screens. Review T1 makes
supervisor-only status powers end with the partner role
([report](reviews/2026-10-07-tasks.md)). Tasks are not shown in the client
portal.

Work that the legal team must do on a matter. A task is part of the matter's
record, not a personal reminder outside it.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Where a task belongs | Every task belongs to exactly one matter, fixed for its life | Project owner |
| Who sees tasks | Active members of the matter's team only. Holding a staff role or permission alone opens nothing | Project owner (follows Matters) |
| Who creates tasks | An active member of an open matter's team, assigning it to an active member of that same team | Project owner |
| Assignment | One assignee. Reassignment is recorded rather than replacing history | Project owner |
| What it holds | A title, optional description, optional due date, priority, assignee, status, creator and creation time | Project owner |
| Priority | Low, normal, high or urgent; normal by default | Project owner |
| Status | Open, completed or cancelled. A new task is open | Project owner |
| Who finishes or cancels | The current assignee, or the matter's active supervising partner while they still hold the partner role | Project owner; current role rechecked by review T1 |
| Reopening | Allowed while the matter is open; the change and who made it are kept | Project owner |
| Deleting | Never. Cancellation is the final-looking action, but it remains in the record and can be reopened | Rule: records are kept |
| Matter state | No task work while a matter awaits conflict clearance or is closed. A matter cannot close with an open task | Project owner; closes Matters review M7 |
| Client portal | Not shown. Tasks and their descriptions are internal | Project owner |
| Reminders | Not in the first version. Automatic reminders belong to Notifications later | Project owner |

## What a task holds

- **Matter**, fixed.
- **Title**, 1 to 200 safe text characters.
- **Description**, optional, up to 2,000 safe text characters.
- **Due date**, optional, as a calendar date (`YYYY-MM-DD`), so a time zone
  cannot move it to another day.
- **Priority:** low, normal, high or urgent; normal unless chosen.
- **Assignee:** one active member of the matter's team.
- **Status:** open, completed or cancelled; new tasks always start open.
- **Created by** and **created at**, fixed.
- Every real change to the details, assignment or status is kept in an
  insert-only record with the complete before and after values, who made it
  and when. Repeating the current value creates no false history.

## Database rules

The API checks first so it can give a useful answer. PostgreSQL checks again
inside the write, so another request cannot change the matter, team or account
between the check and the insert.

Step 12a added `tasks`: `id`, `matter_id`, `title`, `description`, `due_on`,
`priority`, `status`, `assigned_to`, `created_by`, `created_at`.

- Only an active staff member currently on the matter's team can create a
  task, and the assignee must also be active staff currently on that team.
- The matter must be open. `awaiting_clearance` and `closed` both refuse the
  insert.
- The app cannot choose the id, status or creation time. It cannot update or
  delete a task directly. Even the table owner cannot change one outside the
  history trigger, or delete one.
- Text, priority and date values have database constraints as well as request
  validation.
- Migration `0030` locks the matter, membership and account rows which the
  creation check reads. A closure, removal or disable at the same time is
  therefore ordered before or after creation, never missed between a check
  and the insert.
- Migration `0031` also makes the open starting status a database rule for
  every role, including the table owner.

Migration `0032` adds `task_changes`. The app can insert only the task, kind,
requested new values and actor. A database trigger locks the matter and task,
checks that the matter is open and the actor is active on its team, fills the
trusted before values, applies the new current value, and discards no-op
inserts. Assignment must be to an active member of the same team. Only the
current assignee or active supervising partner can change status. A completed
or cancelled task must be reopened before moving to the other final state.

History rows cannot be updated, deleted or truncated, including by the table
owner. The app cannot supply ids, times or before values. Matter closure takes
the same matter lock and is refused while any task remains open, so a closure
and a task status change cannot pass one another unseen.

Review migrations `0033` and `0034` require a recorded supervising partner to
still hold an active partner role before changing somebody else's task status.
They lock that role row with the matter, task, membership and account, so a
role removal and a status change are ordered rather than racing.

## Who can do what

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `tasks.view` - read tasks on your matters | | yes | yes | | |
| `tasks.create` - create and assign tasks on your open matters | | yes | yes | | |
| `tasks.manage` - change, complete, cancel or reopen under the task rules | | yes | yes | | |

A permission is never enough on its own. Every read filters by active matter
team membership. Something outside the person's team answers 404, like
something that does not exist.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/matters/:id/tasks` | `tasks.create` + team, open matter | `{title, description?, dueOn?, priority?, assigneeId}` -> 201 with the task. 400 invalid or unknown fields; 404 not on the team; 409 matter not open or the team changed meanwhile |
| GET | `/matters/:id/tasks` | `tasks.view` + team | `{tasks, next}`: 100 at a time, newest first; `?before=<next>` for the next page. Includes completed and cancelled tasks once those states exist. 404 if not on the team |
| GET | `/tasks/:id` | `tasks.view` + team | The task, assignee and creator display names, oldest-first change history, and `canChangeStatus` for the current person. 404 if not on the team |
| PATCH | `/tasks/:id` | `tasks.manage` + team, open matter | One or more of `{title, description, dueOn, priority}`. 200 with the current task; 400 for empty or unknown fields |
| PUT | `/tasks/:id/assignee` | `tasks.manage` + team, open matter | `{assigneeId}`. The new assignee must be active on the same team. 200 with the current task |
| POST | `/tasks/:id/complete` | `tasks.manage` + assignee or active supervising partner, open matter | 204. Repeating completion is a no-op |
| POST | `/tasks/:id/cancel` | `tasks.manage` + assignee or active supervising partner, open matter | 204. A completed task must be reopened first |
| POST | `/tasks/:id/reopen` | `tasks.manage` + assignee or active supervising partner, open matter | 204. Repeating an open state is a no-op |

Every change route answers 404 outside the active matter team and 409 when the
matter, team, account or task state changed meanwhile. Status changes answer
403 when the caller is on the team but is neither the assignee nor the active
supervising partner.

## Staff screens

- The matter page lists every task newest first, including completed and
  cancelled work. Each row shows status, priority, due date and assignee.
- While the matter is open, the same page has a form to create a task and
  assign it to anyone currently on the team. Closed matters keep the list but
  have no creation form.
- `/tasks/:id` shows the current details and the permanent, oldest-first
  before-and-after history. An unknown task and one outside the person's team
  give the same plain answer.
- While the matter is open, any team member can edit details or reassign the
  task. Status buttons use the API's current decision and appear only to the
  current assignee or a supervising partner who still holds the partner role.
  A closed matter leaves the task and history read-only.
- The screens use the API for every decision. Hidden forms and buttons make
  the page clearer; they are not security controls.

## Audit

Step 12a records `task.created`, in the same transaction as the task. It uses
ids and non-sensitive facts only: matter id, assignee id, priority and whether
there is a due date. It never records the title or description, which may hold
client information.

Each real change is audited in the same transaction as its history and current
value. Detail changes use `task.updated` with the changed field names;
assignment uses `task.reassigned` with the before and after account ids; status
uses `task.completed`, `task.cancelled` or `task.reopened` with the before and
after states. Audit metadata does not copy task titles, descriptions, names or
due dates. A failed audit write rolls the whole change back.

## Not in this module

- Client portal tasks.
- Automatic reminders and email: Notifications later.
- Time recording and billing: Finance later.
- General tasks which have no matter.

## Build order

Each step ships with positive and negative tests, deliberate breaks of every
safeguard, and documentation before the next.

- **12a.** The task table and database safeguards; `tasks.view` and
  `tasks.create`; create, list and details in the staff API; `task.created`
  audit. Done.
- **12b.** Insert-only detail, assignment and status changes; permissions and
  actor rules; completion, cancellation and reopening; refuse matter closure
  while an open task remains. Done.
- **12c.** Staff screens on the matter and task pages: list, create, edit,
  reassign and status actions. Done.
- Security review of the module. Done
  ([report](reviews/2026-10-07-tasks.md)); T1 fixed.
