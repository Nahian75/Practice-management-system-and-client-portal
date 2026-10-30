# Clio Manage reference and Stass implementation

Reference reviewed: 30 October 2026. Scope: **Clio Manage first**, as selected by the project owner. Clio Grow, Clio Draft, Clio Work and enterprise products are separate future decisions.

The dashboard layout follows the supplied authenticated-screen screenshot: global toolbar, sidebar, dashboard tabs, agenda tiles, hours ring, six billing cards and four financial-period charts. The current colour scheme uses cool slate surfaces, a graphite navigation sidebar and matching toolbar, navy buttons, and blue decorative highlights. Stass displays its own records, account name and branding.

The screenshot's unpaid/overdue bill cards are represented by **issued bills and credit notes** until Stass supports complete bill-level payment allocation. The labels explicitly distinguish invoice totals from unpaid balances.

The current implementation adds saved weekday hours targets, Ctrl+K search, a collapsible sidebar, a browser-tab start/pause timer with a reviewed time-entry handoff, personal/firm time-value metrics, an authorised audit feed, a firm billing register and a separate bank-account list. Personal metrics are filtered to the worker and their current matter teams; firm metrics and billing summaries require firm-finance access, and the feed requires audit access.

The supplied EU application URL redirects to Clio sign-in. No authenticated Clio account was inspected. The reference for this work is Clio's public [navigation guide](https://help.clio.com/hc/en-us/articles/9290390462875-Navigate-Clio-Manage), [task guide](https://help.clio.com/hc/en-au/articles/9204917906971-Manage-Tasks-in-Clio-Manage), and [UK feature overview](https://www.clio.com/en-gb/features/). The implementation follows the published workspace structure. It does not establish identical behaviour or complete feature parity with Clio.

## Design applied to the prototype

- A persistent graphite navigation sidebar, a matching graphite top toolbar, global record search and a Create new menu.
- Main work sections: dashboard, calendar, tasks, matters, contacts, activities, documents, billing/accounts, reports and settings. Existing compliance, personnel and learning workspaces remain accessible.
- Navy primary actions, slate text on cool slate surfaces, 8-point spacing, restrained borders, compact tables and section tabs. Stass retains its own name and vector logo.
- A personal dashboard with today's actual task deadlines and appointments, accessible matter/contact counts, recorded time and notifications. No fabricated financial charts or performance percentages.
- Locally hosted Public Sans typography, consistent SVG line icons, and short menu/control transitions. Reduced-motion preferences disable workspace animations and transitions. Font licence is included in `apps/web/public/fonts/public-sans/OFL.txt`; font source: [Google Fonts Public Sans](https://github.com/google/fonts/tree/main/ofl/publicsans).
- A consistent heading, primary action, table/filter area, pagination or empty state. Existing page instructions remain available in a keyboard-accessible disclosure.
- Mobile navigation scrolls inside its own region; wide calendars and tables scroll inside their containers. Account settings and sign-out remain available on mobile.

Shared implementation: `apps/web/src/app/manage.css`, `components/nav-links.tsx`, `components/workspace-toolbar.tsx`, `components/workspace-page.tsx` and the staff layout. The public login and client portal retain their existing dedicated layouts.

## Feature-by-feature status

“Existing” means a feature is present in this repository, not a certification that it has the same depth or behaviour as Clio. “Added” identifies work in this adaptation. Pending features are not displayed as working controls.

| Area | Stass route / implementation | Current status and limits |
| --- | --- | --- |
| Personal dashboard | `/` | Added agenda and navigation; actual records from authorised APIs. Counts are labelled when paginated. |
| Firm performance dashboard | `/?view=firm` | Added aggregate recorded-time metrics and billed/unbilled time-value charts for four periods. Utilisation, realisation, collection, payment allocation and financial targets remain gaps. |
| Firm activity feed | `/?view=feed` | Added a permission-controlled view of the latest 30 audit actions/outcomes/timestamps. It excludes restricted record contents. Feed filters remain a gap. |
| Global search | `/search`, `/workspace/search` | Added accessible matters/contacts plus task/document title search. The record groups have explicit result caps. No cross-matter permission bypass. |
| Quick creation | Top Create new menu | Added entry points for contact, matter, task, appointment, document and time entry. Matter-dependent actions select a matter first. |
| Matters | `/matters`, `/matters/[id]` | Existing case records, teams, parties, conflict gates, closure and history. Added status tabs and a filter for the loaded page. Global search searches all accessible matter records. |
| Contacts | `/clients`, client detail/contact forms | Existing individual/organisation clients, contact people, correspondence details and responsibility controls. Updated directory presentation. Standalone non-client contact CRM remains a gap. |
| Task workspace | `/tasks`, `/workspace/tasks` | Added cross-matter listing, search, status and assignee filters, pagination and matter links. |
| Task creation and history | `/tasks/new`, `/tasks/[id]` | Reuses existing create/edit/reassign/complete/cancel/reopen actions, assignee rules and change history. |
| Task templates and relative deadlines | No dedicated implementation | Pending reusable task lists, recurring schedules, dependent dates and bulk task operations. |
| Personal calendar | `/calendar`, `/calendar/new`, `/workspace/events` | Added persistent appointments, optional matter association, monthly view, appointment agenda and cancellation history. Appointment times display in Europe/London; entry uses device time. |
| Task deadlines on calendar | `/calendar` | Added due dates for the viewer's assigned tasks. Additional results are signalled when display limits are reached. |
| Shared calendars and external sync | No connected calendar provider | Pending attendee invitations, shared team calendars, Outlook/Google sync, reminders and recurrence. Appointments are private to their creator. |
| Court deadline rules | No rules provider | Pending jurisdiction-specific calculation and review workflows. The calendar does not calculate legal deadlines. |
| Activities / time register | `/activities`, `/workspace/activities` | Added cross-matter time register, description/date filters and entry links. Existing rates, corrections and void history remain in force. |
| Time recording | `/activities/new` | Reuses the existing matter time form. The toolbar timer hands rounded minutes to the form; a user chooses the matter/date/description and confirms recording. |
| Live timers and expenses | Toolbar timer | Added a per-account browser-tab timer with session persistence, start/pause/reset and time-entry handoff. Cross-device timers, expense entries, categories and supporting receipt flows remain gaps. |
| Documents | `/documents`, `/workspace/documents` | Added cross-matter latest-version view, title search, pagination and explicit client-sharing state. Withdrawn/inaccessible records are excluded. |
| Document upload and versions | `/documents/new`, `/documents/[id]` | Reuses existing malware scanning, envelope encryption, versions, downloads and controlled sharing. |
| Document automation and signatures | Existing engagement signing | Partial. Engagement workflows exist; generic document templates, merge fields, folder management, external-drive sync and general e-signature integrations remain gaps. |
| Billing | `/billing`, `/finance`, draft/bill routes | Added paginated draft/invoice/credit registers and live summary cards. Existing draft/issue/credit/delivery flows remain. Complete unpaid-balance tracking, invoice customisation and batch billing remain gaps. |
| Bank accounts and reconciliation | `/accounts`, `/finance` | Added a separate bank-account directory. Existing statements, reconciliation and independent sign-off controls remain. |
| Client-money requests | `/finance`, portal payment-request views | Existing requests, authority and bank-confirmed outcomes. The application records these; it does not itself move money. |
| Connected online payments | No payment processor connected | Pending provider selection, hosted checkout, webhooks, refunds, transaction reconciliation and payment plans. |
| Communications | Existing notifications/outbound account and task emails | Partial. Not a client conversation inbox. Secure matter messaging, email filing and phone-call logs remain gaps. |
| Client portal | `/portal` | Existing controlled matter records, shared files, engagement and evidence/payment-request workflows. It retains a separate access boundary and layout. |
| Reports | `/reports` | Added reporting hub for existing task/time registers, financial records and controlled compliance/HR exports. Custom report builders, report scheduling and KPI dashboards remain gaps. |
| Staff and permissions | `/settings`, `/staff` | Existing invitations, roles, disabling and recovery controls; added a settings hub. Stass keeps its own granular role model. |
| Policies, compliance and HR | `/policies`, `/compliance`, `/hr`, `/people` | Existing Stass-specific workflows retained. These are not representations of Clio functionality. |
| App integrations | Existing provider-specific backend configuration | No marketplace UI, calendar/mail sync or general OAuth connection manager. Providers must be implemented and verified individually. |
| Mobile application | Responsive browser interface | Responsive web prototype; no native iOS/Android application or offline sync. |
| Regional e-filing | No implementation | Out of the current UK prototype scope; no court submission capability is implied. |

## Data and permission changes

Migration `0076_personal_calendar.sql` adds `app.calendar_events` and `app.calendar_event_cancellations`. Records are append-only: cancellation does not overwrite the appointment. Database triggers require active staff and appropriate matter-team membership when associating a matter. Only the appointment creator can cancel it.

Migration `0077_performance_preferences.sql` stores the authenticated employee's daily hours target. Target updates and their audit records commit in one transaction. The application never accepts another employee's account ID in the target-setting endpoint. Values on the charts come from current non-voided time entries and issued time lines; billed values exclude subsequent credits and are labelled accordingly.

The workspace API uses the existing role guard and the same current-team visibility predicate as individual matters. Global search applies the client responsibility/team predicate. Calendar appointments are private to their creator, and matter-associated appointments are hidden if that creator loses matter access. Events and cancellations commit together with their audit records; failed auditing rolls back the change.

Calendar access currently follows the existing task permissions. Appointment editing, calendar sharing, detailed reminder preferences and a dedicated calendar-retention/disposal workflow are not implemented. Rescheduling currently requires cancelling and creating a replacement. Use synthetic data while evaluating these new prototype features.

Hosting remains compatible with the prepared Render and Linux Docker configurations. Both apply pending SQL migrations before starting the updated API. Preserve the original deployment encryption secrets when updating.

## Validation

- API tests cover unauthenticated/client/incorrect-role rejection, task and search isolation, valid list responses, private event persistence, owner-only cancellation, inaccessible matter associations, invalid dates and audit failure rollback.
- Existing task controller tests were run alongside the new workspace tests.
- The current combined API run passed 53 tests, including saved-target privacy, audit rollback, real time-value aggregation, void handling, draft VAT totals and firm-finance permissions. The client-creation, staff-invitation and Accounts-workspace browser regressions passed, along with their AML setup dependency.
- Client onboarding's static inline styles were moved into reusable Tailwind classes, preserving the strict Content Security Policy. The client regression verifies that the tested flow produces no CSP violations.
- Both TypeScript checks and production builds pass.
- `scripts/check-manage-ui.mjs` signs in using local-only demo credentials, checks thirteen desktop sections, creates/cancels a real test appointment, checks search, captures mobile screens and runs representative automated accessibility checks.
- Screenshots and accessibility results are in `docs/manage-ui-assets/`. These checks do not establish complete accessibility conformance or production readiness.

## Remaining work toward broader Manage parity

The implemented workspace is the first functional adaptation. The gaps above should be developed as real workflows, with their own permissions, migrations and meaningful tests. The next substantial areas are communications, shared calendars/integrations, expenses, advanced report metrics and document automation. Connected payments requires an actual processor account and verified webhook/payment handling. No provider should be represented as connected before it is configured and exercised.
