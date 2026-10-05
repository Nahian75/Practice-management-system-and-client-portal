# Web app

**Current state (2026-10-05):** Steps 9a and 9b built: the app, its security
headers, the pass-through to the API, the layout, sign in with 2FA or a backup
code, sign out, a signed-in home page, accepting an invitation, and password
reset. The other screens are designed below.

The staff app, in the browser. The client portal comes later, in the same app.

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

## Security in the web app

- **Content Security Policy** with a fresh nonce per page: scripts only from
  the app itself, no inline scripts without the nonce, no `eval`, no framing
  (`frame-ancestors 'none'`), forms only to this site.
- The same security headers as the API (no sniffing, strict referrer policy,
  HSTS in production, permissions policy denying camera, location and the rest).
- No data in `localStorage` or `sessionStorage`; nothing cached by the browser
  for signed-in pages (`Cache-Control: no-store`).
- What a screen shows comes from the API's answer, which the API already
  filters; the web app adds no access rules of its own and none are needed
  for safety. Hiding a button is for clarity, never a control.
- Error pages show a reference, never details.

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

- The client portal (after Documents, so clients have something to see).
- Dark mode, printing styles, and Welsh language.
