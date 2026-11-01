# Staff access and navigation review ? 1 November 2026

The staff list now labels its invitation link **Add user**, shows All users / Active / Invited / Disabled status filters with counts, and exposes per-account links to role and access controls. Disable and re-enable links open the account controls; they do not change access until the action button is used. The user's own account is identified and cannot be managed by that same user. Partners see read-only controls; API permission checks remain authoritative.

The HR role was absent from the frontend role labels and role controls even though the API supports it. It is now available alongside Administrator, Partner, Fee earner, Accounts and Compliance.

Policies & guidance and Report a concern now have sidebar links. Page suggestions and submitted searches now include Dashboard, Activities, Reports, Notifications, Policies, Report a concern, personal performance settings, and finance/compliance/HR entry points when access allows. Personnel self-service and manager pages remain under Team directory; finance and compliance detail tools remain under their parent workspaces.

## Source navigation audit

Reviewed 39 static staff routes and 32 record-specific routes. A source scan found 0 static staff routes without an inbound literal link from another source file. This checks source discoverability, not every role-specific runtime state.

| Static staff route | Inbound source link |
| --- | --- |
| `/` | Dashboard entry |
| `/accounts` | Present |
| `/activities` | Present |
| `/activities/new` | Present |
| `/billing` | Present |
| `/calendar` | Present |
| `/calendar/new` | Present |
| `/clients` | Present |
| `/clients/new` | Present |
| `/compliance` | Present |
| `/compliance/ai` | Present |
| `/compliance/exports` | Present |
| `/compliance/restricted-reports` | Present |
| `/compliance/retention` | Present |
| `/documents` | Present |
| `/documents/new` | Present |
| `/finance` | Present |
| `/help` | Present |
| `/hr` | Present |
| `/hr/exports` | Present |
| `/hr/retention` | Present |
| `/matters` | Present |
| `/matters/compliance-access` | Present |
| `/matters/supervision-takeover` | Present |
| `/notifications` | Present |
| `/people` | Present |
| `/people/cases` | Present |
| `/people/me` | Present |
| `/people/team` | Present |
| `/policies` | Present |
| `/report-concern` | Present |
| `/reports` | Present |
| `/search` | Present |
| `/settings` | Present |
| `/settings/performance` | Present |
| `/staff` | Present |
| `/staff/invite` | Present |
| `/tasks` | Present |
| `/tasks/new` | Present |

## Validation

Production build and source guards are run for this change. Regression scenarios cover administrator actions, status filters, the HR role, and read-only partner access. In-app browser execution is unavailable because its connection fails with a sandbox metadata error; browser tests are not claimed as executed. Authenticated HTTP checks validate rendered controls without changing another user's account.
