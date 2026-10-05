# Web app

**Current state (2026-10-05):** Step 9a built: the app, its security headers,
the pass-through to the API, the layout, sign in with 2FA or a backup code, sign
out, and a signed-in home page. The other screens are designed below.

The staff app, in the browser. The client portal comes later, in the same app.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Framework | Next.js 16 (React 19, TypeScript strict), UI only: every rule stays in the API | ADR-004 |
| Look | Minimal, UK law-firm style: calm, text-led, deep navy (`#1B2A41`) | Project owner |
| Name shown | "reglify", from configuration (`APP_NAME`), not from code | Project owner |
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
| **9d** | Matters: conflict check and opening, list, view (team, parties, conflict check, clearance), editing, team changes, closing, supervision takeover, compliance access |
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
