# Web app

**Current state (2026-10-07):** The staff app screens through Tasks step 12c
and portal administration are built. Portal step 11d adds the read-only client
screens, using the same secure pass-through and a separate client layout. The
staff and client sides are security-reviewed through the portal work.

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
  Complete and cancel or reopen buttons appear only to the current assignee or
  supervising partner. Closed tasks stay readable but every change control is
  absent.
- An unknown task and one outside the person's matter team have the same
  screen. The API remains the security boundary and rechecks every operation;
  the screen's hidden controls are only for clarity.

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
