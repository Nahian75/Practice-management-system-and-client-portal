# Web app

Cleanup update (31 October 2026): the unused `StatusTag` component, its unused style variants and two superseded dashboard style implementations were removed. `src/app/tailwind.css` retains the Tailwind theme and utility imports, in the same layout import position. The active dashboard continues to use `reference-theme.css`; shared workspace rules remain in `manage.css`. The production build, strict type check and all 101 browser tests passed. See the [cleanup review](reviews/2026-10-31-code-cleanup.md).

**Current state (2026-10-13):** The staff app screens through Finance step
14f, Compliance step 15f and People / HR step 16f, and portal administration are built. Portal step 11d adds the
read-only client screens, using the same secure pass-through and a separate
client layout. The staff and client sides are security-reviewed through the
portal work; the task and Finance screens were checked again with their module reviews.

The staff app and client portal, in the same browser app with separate layouts.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Framework | Next.js 16 (React 19, TypeScript strict), UI only: every rule stays in the API | ADR-004 |
| Look | Minimal, UK law-firm style: calm, text-led, deep navy (`#1B2A41`) | Project owner |
| Name shown | "Stass", from configuration (`APP_NAME`), not from code | Project owner |
| Language and formats | British English; dates as "5 October 2026"; times in UK time | Proposed |
| Accessibility | WCAG 2.2 AA | Proposed |
| Third parties at runtime | None: no external fonts, scripts, analytics or CDNs | Proposed |

## How the browser reaches the API

```
Browser ──► Next.js (apps/web) ──► NestJS API (apps/api)
            same address          private, not reachable from the browser
            /api/* passed through
```

- The browser only ever talks to the web app's address. Requests to `/api/...`
  are passed through to the API unchanged, with the browser's cookie.
- So the session cookie (`__Host-session`, set by the API) stays on one site,
  and the API's CSRF protection, which reads the browser's `Sec-Fetch-Site`
  header, sees same-site requests. No CORS, no tokens in JavaScript.
- Pages that show data are rendered on the server, which calls the API with
  the visitor's cookie. Forms send JSON to `/api/...` from the browser.
- The web app holds no secrets and never talks to the database.

## Built in Compliance step 15f

- Every staff role sees `/report-concern`. It sends JSON without a file or
  multipart with one file, shows only a neutral receipt and never provides a
  report-history link or general notification.
- Only a successful `/compliance/access` capability check reveals the
  `/compliance` workspace. Its navigation attention count contains ordinary
  sanctions/hold/retention work only; restricted reports and their linked holds
  are excluded in PostgreSQL.
- The dashboard shows ordinary review, hold, sanctions and retention work,
  and lets Compliance resolve screening candidates, impose or lift operational
  holds and validate/activate an official UK Sanctions List CSV.
  `/compliance/retention` records relationship ends and legal-hold events and
  requires typing `DISPOSE` before the irreversible action. `/compliance/exports`
  creates and downloads fixed ordinary bundles.
- The “Nominated-officer records” link and pages exist only when the capability
  says the current Compliance account has a live appointment. Queue summaries
  contain no narrative. Detail supports permanent decisions, external filing,
  DAML/DATF events, protected attachments/exports and the separate access log.
- Client and matter pages show safe AML state and link to internal CDD/risk
  work. A protected CDD workspace records people/entities, evidence,
  verification, ownership/control and authority before immutable submission or
  abandonment. A matter assessment workspace records measures and results,
  source conclusions, Compliance clearance and separate senior approval.
  Compliance-only client headings come from the narrow four-field picker, not
  the ordinary client-detail route. No Compliance route exists in the portal.
- Playwright covers the three confidentiality boundaries, a complete protected
  CDD workflow, desktop and 390 px layout, and axe on each completed workflow.

## Built in People / HR step 16f

- Every active staff account sees `/people`: a safe directory plus links to its
  own linked record, current direct reports and explicitly assigned confidential
  cases. The HR workspace link appears only when `/hr/access` reports a live HR
  capability; that response is presentation only and grants no API access.
- `/people/me` combines the filtered self-service projections and supports
  contact versions, corrections, leave and adjustment requests, development,
  learning completion and responses to objectives/appraisals. Restricted data
  never passes through the directory.
- `/people/team` is a live PostgreSQL-derived direct-report list. Detail contains
  only the existing manager projections and actions; a superseded reporting
  line becomes a not-found response on reload. `/people/cases` uses the separate
  explicit membership boundary, so a designated case participant needs no
  general HR role.
- `/hr` reveals only sections covered by the holder's capabilities. Personnel
  detail provides employment, private-file, correction, leave/pay, health,
  adjustment, lifecycle, vetting, competence and review workflows. Dedicated
  retention and export screens preserve typed permanent-disposal confirmation,
  legal-hold history, two-person review and user-initiated private downloads.
- Server components request already-filtered API shapes with the session cookie.
  Client forms submit to same-origin `/api` routes and contain no authorization,
  payroll, legal or employment-decision rules.
- Playwright proves the ordinary-staff, HR, current/former-manager and self-
  service boundaries, including the principal workflow at 390 px and axe checks.

## Built in 9a

- `apps/web`, Next.js 16.3 with React 19.3, TypeScript strict as in the API.
- `src/proxy.ts` (Next.js 16's name for middleware) passes `/api/...` to the
  API and gives every page a fresh nonce and the security headers. The API
  address is built in `src/lib/api-target.ts` by setting the path on a fixed
  URL: joined as text, `/api//evil.example/x` would have been sent to another
  server. Tests cover that and two other tricks.
- The API address and the name come from the environment at run time
  (`API_URL`, `APP_NAME`); the API now listens on the private port 3001 and
  trusts the web app as its proxy (`TRUSTED_PROXIES=loopback` locally), so
  per-address sign-in limits still see each visitor's own address.
- Every page is rendered per request (`force-dynamic`), so each gets its own
  nonce and nothing signed-in is cached.
- Server-rendered pages read from the API with only the visitor's session
  cookie (`src/lib/api.ts`). The staff layout sends anyone without a staff
  session to sign in; the type checker refuses to build if that check is
  removed, because the header then uses an account that may not exist.
- Sign-in is two steps, password then code, showing the API's own messages
  in an error summary that takes focus.
- Fonts are downloaded when the app is built and served from the app itself.

## Built in 9b

- `/accept-invitation`: the invitation is checked, then a password (typed
  twice), then the authenticator: a QR code and the key as text, confirmed with
  a code; then the ten backup codes, shown this once.
- The QR code is drawn as SVG squares in the page from the set-up link, using
  `qrcode-generator` (MIT, no dependencies; chosen over `qrcode`, which brings a
  command-line toolkit). The secret is never sent anywhere to become an image.
- `/forgot-password` gives the same answer whether or not the address has an
  account; `/reset-password` sets the new password from the emailed link.
- Links carry their token after `#`, which browsers never send to a server;
  the page reads it and removes it from the address bar and history at once.
  A test fails if it stays.
- A refused password shows every reason the API gives.

## Built in 9c

- `/clients`: the clients you are responsible for, newest first, with "Older
  clients" for the next page. A search box looks across the whole firm by
  name or reference, as the API allows.
- The search runs from the browser, not the web server, so the audit record
  of who searched keeps the searcher's own IP address. It counts against the
  same hourly allowance as conflict checks; when that is used up, the page says
  so.
- `/clients/new` and `/clients/:id/edit`: one form for individuals and
  organisations. The kind is chosen only on create. Dates of birth are three
  boxes (day, month, year), the UK pattern. Emptying an optional field removes
  it, rather than leaving the old value.
- `/clients/:id`: details, contacts (organisations) and the client's matters.
  A client someone else is responsible for shows only "You cannot see this
  client", with the takeover form; the API decides whether a takeover is
  allowed (partners only, with a reason, audited).
- Contacts are added and changed on their own pages. A contact who leaves is
  marked as no longer a contact, never deleted. The change page looks the
  contact up in that client's own list, so another client's contact cannot be
  opened through it.
- Countries in address forms are the API's own list, copied; a test fails if
  the two lists differ.

## Built in 9d-2

- `/matters`: the matters you are on the team of, newest first.
- `/clients/:id/matters/new`: opening a matter, in the order the API
  requires. First the other parties (up to 20, each with a role and whether
  it is a person or an organisation) are checked for conflicts; the client is
  always checked too. Then the results are shown, and the matter is opened on
  that check: title, type of work, supervising partner (from the partners in
  `GET /colleagues`) and any other fee earners. Changing the parties means a
  new check.
- `/matters/:id`: details, team, other parties and the conflict check with its
  possible matches, by reference only. A matter awaiting clearance says so at
  the top; its supervising partner sees the form to record why the possible
  matches are not a conflict, which opens the matter.
- A matter someone is not on the team of shows "You cannot see this matter",
  the same as one that does not exist.

## Built in 9d-3

- `/matters/:id/edit`: anyone on the team changes the title or type of work.
- `/matters/:id/team` (supervising partner): add a fee earner from the
  colleagues list, remove one (they lose access at once), or hand supervision
  to another partner, after which the previous partner is a fee earner.
- `/matters/:id/close` (supervising partner): a reason and a tick to confirm,
  because closing is final. A closed matter shows no change links, and the
  change pages send the person back to the matter page.
- The matter page shows its supervising partner every compliance access to the
  matter: when, who and why.
- `/matters/supervision-takeover` (partners): the matter's reference and a
  reason. The API allows it only when the supervising partner can no longer act.
- `/matters/compliance-access` (compliance): the matter's reference and a
  reason, then the matter, read-only. It is shown only in the page's memory:
  reloading forgets it, and each look is another record.
- The API does not tell the web app a person's roles. Supervising-partner
  actions appear only to the matter's supervising partner (known from the
  team); takeover and compliance access are linked from the Matters page for
  everyone, and the API refuses anyone else.

## Built in 9e

- `/staff`: every staff account with its email, status and roles, for
  administrators, partners and compliance (`staff.view`). Others see "No access".
- `/staff/invite` (administrators): name and email address. The person then
  has a page of their own where roles are given, one at a time, so a refused
  role never leaves others half done.
- `/staff/:id`: each role with what it is for, and a button to give or
  remove it; disabling the account (signs them out at once; roles and matter
  teams stay) or re-enabling it (a new invitation; the old password is gone).
- One's own account shows no change buttons: another administrator makes those
  changes. The API refuses them anyway, and refuses removing the last active
  administrator or compliance holder; its reasons are shown as given.
- A partner or compliance holder pressing a change button is told only
  administrators can change staff accounts.

## Built in 10d

- The matter page has a Documents section: the documents, newest first, with
  each one's latest version, size and a download link; and, while the matter
  is open, a form to add one (title, category, file).
- `/documents/:id`: every version with its download link, a form for a new
  version, and, for whoever added the document or the matter's supervising
  partner, withdrawal with a reason and a tick to confirm. A withdrawn
  document says who withdrew it, when and why, and has no download links.
- Files are sent from the browser through `/api` as a multipart form, the
  title and category before the file, as the API reads them. The page refuses
  a missing file or one over 50 MB before sending it; the API checks
  everything again and its reasons (wrong type, macros, malware, scanner
  unavailable) are shown as given.
- Downloads are plain links to the API through the pass-through; the API sends
  them as attachments, so they are saved, never shown.
- The pass-through holds request bodies up to `proxyClientMaxBodySize` and
  silently cuts off the rest (Next.js logs a warning). It is 52 MB, just above
  the API's 50 MB limit, so an upload always reaches the API whole. Next.js
  keeps the whole body of every request it passes on in memory, so in
  production the reverse proxy sends `/api/…` straight to the API instead
  ([deployment.md](deployment.md), review D2); the pass-through serves
  development and the tests.

## Built in 11a-2

- The client page has a "Portal access" section, for those who manage it:
  who can see the client in the portal, their status and since when, with
  "End access"; and an invite button for the individual client, or for each
  current contact, naming the address on record the invitation goes to.
  Someone without an address on record gets a link to add one instead.

## Built in 11b

- The document page says whether the document is shared with the client and
  lets the matter team share it or stop sharing it. It explains that the
  portal will show only the latest version.
- A withdrawn document has no sharing control. Withdrawing one that was
  shared stops sharing it in the same transaction.

## Built in 11d

- `/portal` lists the matters available to a client. Its layout shows only
  "Your matters", the client's name and sign out; staff navigation is absent.
- `/portal/matters/:id` shows only the client-safe matter fields and the
  shared, unwithdrawn documents returned by the portal API. Downloads use the
  versionless portal address, which always means the latest shared version.
- Sign-in uses the account kind returned after two-factor authentication:
  staff go to `/`, clients to `/portal`. The staff and portal layouts also
  send an already signed-in person back to the correct side.
- Portal pages are server-rendered per request with `no-store`. When the API
  reports that access ended, the matter page shows the same plain message as
  an unknown matter and no earlier details remain on the page.
- Browser tests create the client through the real invitation and two-factor
  flow, check both layout boundaries, verify the exact downloaded bytes, and
  run axe on the matter list and detail screens.

## Built in 12c

- The matter page has a Tasks section: newest first, with status, priority,
  due date and assignee. Completed and cancelled tasks remain visible. Open
  matters also show a form for title, optional description and due date,
  priority and an assignee from the current team.
- `/tasks/:id` shows the current details and complete oldest-first history.
  Detail changes show both full snapshots; assignment and status changes show
  their before and after values, with who changed them and when.
- On an open matter, every team member sees detail and reassignment forms.
  Complete and cancel or reopen buttons use the API's current capability and
  appear only to the current assignee or an active supervising partner who
  still holds the partner role. Closed tasks stay readable but every change
  control is absent.
- An unknown task and one outside the person's matter team have the same
  screen. The API remains the security boundary and rechecks every operation;
  the screen's hidden controls are only for clarity.

## Built in 13d

- Every staff header links to `/notifications` and shows the API's current
  unread count. Its accessible name states the count clearly.
- `/notifications` shows the 50 newest visible records, their generic event
  wording, current task title, status and due date, read state and creation
  time. Older pages use the API cursor. Each title links to the task.
- "Mark as read" posts through the same-site API pass-through and refreshes
  both the item and header count. A 404 refreshes the page so access lost
  between display and click leaves no stale item behind.
- The page renders only fields returned by the filtered Notifications API. It
  does not fetch descriptions, matter titles or client details. Client accounts
  see no notification navigation and are redirected from the staff route.

## Built in 14f

- Visible matter pages include a Time and finance area with safe time
  summaries, own-time entry, permanent correction history, issued bills and
  fixed bill downloads. The API's matter record rule still decides whether
  the section exists.
- `/finance` is the firm-wide Accounts/Compliance workspace. It shows
  five-week statement and signed-reconciliation deadlines, draft-bill,
  payment-request, statement and reconciliation queues, and the safe bank
  register. The Finance link appears only when the live API capability route
  permits firm-wide finance.
- Accounts can build and issue multi-line bills, record delivery and credit
  notes, register bank accounts and receipts, request/approve/cancel client
  payments, record bank outcomes, import inert CSV statements, match/reverse
  rows and prepare reconciliations. Sensitive payee details are fetched only
  on an explicit, audited reveal.
- Compliance sees the same firm-wide ledgers, cash books, statements,
  payments and fixed reconciliations read-only, with only the separate
  reconciliation sign-off action. UI capabilities are for clarity; the API
  rechecks every permission, actor separation and live accounting rule.
- Matter ledgers, bank cash books and fixed reconciliations download as
  audited UTF-8 CSV attachments. Every field is quoted and formula-like text
  is prefixed as literal data. Statement rows and cash-book entries show their
  exact reconciliation source keys for copying into an outstanding-item
  explanation. There are no client-portal Finance routes.
- Tables scroll on narrow screens; forms keep explicit labels, error/status
  announcements and keyboard focus styling. Finance Playwright coverage runs
  axe WCAG 2.2 AA checks and a 390-pixel viewport workflow.

## Security in the web app

- **Content Security Policy** with a fresh nonce per page: scripts only from
  the app itself, no inline scripts without the nonce, no `eval`, no framing
  (`frame-ancestors 'none'`), forms only to this site.
- The same security headers as the API (no sniffing, strict referrer policy,
  HSTS in production, permissions policy denying camera, location and the rest).
- No data in `localStorage` or `sessionStorage`; nothing cached by the browser:
  pages and API answers are sent with `Cache-Control: no-store`, and signing out
  tells the browser to clear its cache (`Clear-Site-Data`, review W2).
- What a screen shows comes from the API's answer, which the API already
  filters; the web app adds no access rules of its own and none are needed
  for safety. Hiding a button is for clarity, never a control.
- Error pages show a reference, never details: when a page fails (for example,
  the API is down) it shows Next.js's error reference, which finds the full
  error in the server's log. Addresses with no page, and malformed ids, get
  "Page not found" (review W4).
- The web app listens on `127.0.0.1` only, and is reached through a reverse
  proxy on the same machine that reports the browser's real address
  ([deployment.md](deployment.md), review W1).

## Look

- Headings in a serif (Source Serif 4), text in a plain sans-serif (Source Sans
  3), both bundled with the app at build time.
- Near-black text on white; deep navy for the header bar, links and buttons;
  one muted red for errors and destructive actions. Contrast at least 4.5 to 1.
- Thin rules, generous white space, no rounded "app" cards, no shadows, no
  animation. Tables for lists, labels above fields, one primary action per page.
- Plain CSS with a handful of shared tokens (colours, spacing, type sizes). No
  CSS framework: the screens are simple, and fewer dependencies is safer.
- Works at 320 pixels wide, keyboard only, and with a screen reader.

## Screens, in build order

| Step | Screens |
|---|---|
| **9a** | App set-up, security headers, the pass-through to the API, the shared layout; **sign in** (password, then 2FA code or backup code), **sign out**, a signed-in home page |
| **9b** | Accepting an invitation (password, 2FA set-up with a QR code, backup codes shown once); password reset |
| **9c** | Clients: list, search, create (individual or organisation), view with contacts and matters, edit, contacts, takeover |
| **9d** | Matters, in three parts. 9d-1: the colleagues list in the API. 9d-2: conflict check and opening, list, view (team, parties, conflict check, clearance). 9d-3: editing, team changes, closing, supervision takeover, compliance access |
| **9e** | Staff (administrators): list, invite, roles, disable and re-enable |
| **10d** | Documents on the matter and document detail pages: upload, version, download, withdraw and client sharing |
| **11a/11d** | Portal access administration and the separate read-only client portal |
| **12c** | Tasks on the matter and task detail pages: create, list, edit, reassign, complete, cancel, reopen and history |
| **13d** | Notifications: staff header unread count, inbox, mark read, task links and older pages |
| **14f** | Matter time/finance; Accounts billing, receipts, payment and reconciliation workspaces; Compliance read-only ledgers and sign-off; audited CSV exports |
| **15f** | Confidential staff concern; Compliance dashboard and operational actions; client CDD and matter assessment work; retention/legal holds/disposal; ordinary exports; separately revealed nominated-officer records and restricted exports |
| **16f** | People directory and self-service; current-manager team records; membership-scoped confidential cases; least-privilege HR personnel, leave, health, lifecycle, vetting, competence, retention and export workspaces |
| | Security review of the web app |

## Testing

- **End to end with Playwright**: a real browser against the real web app and
  API, synthetic data. Every screen's main path, plus the security behaviour:
  signed-out visits redirect to sign-in, the CSP and headers are present, a
  cross-site form post is refused, and nothing is stored in the browser.
- Accessibility checks with axe on every screen in the end-to-end tests.
- Small unit tests for formatting helpers (dates, references).

Playwright downloads its browsers once (`npx playwright install chromium`); the
repository's npm settings still apply (no install scripts, packages at least
seven days old, exact versions).

## Not in the first version

- Dark mode, printing styles, and Welsh language.
