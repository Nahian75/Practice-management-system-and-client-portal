# Finance

**Current state (2026-10-09):** First-version design approved by the project
owner. Steps 14a to 14c are built: exact GBP money strings, immutable staff
rates and time entries, permanent corrections, billing, an encrypted bank
register, balanced client/business postings, receipts, allocation corrections,
derived ledgers, permissions, audit and the staff API. Withdrawals, bank
outcomes, reconciliation and Finance screens are later steps.

How Stass records time, bills and money on matters while keeping client money
separate, answerable and difficult to misuse. Stass is the legal practice
record; it does not pretend that typing a payment into Stass moves money at the
bank.

## Regulatory basis

The first version is for a firm regulated by the Solicitors Regulation
Authority in England and Wales.

- [SRA Accounts Rules](https://www.sra.org.uk/solicitors/standards-regulations/accounts-rules/)
  require client money to be kept separate, allocated promptly, withdrawn only
  for a proper purpose with sufficient money held for that client, and recorded
  accurately, contemporaneously and chronologically. A transfer for costs
  needs a bill or written notice first.
- The same rules require statements for client and business accounts at least
  every five weeks, and reconciliation of client accounts at least every five
  weeks with sign-off by the COFA or a manager.
- [SRA guidance on accurate client accounting records](https://www.sra.org.uk/solicitors/guidance/accurate-client-accounting-records/)
  recommends evidence for each payment, controls that prevent debit balances,
  prompt correction, lists of outstanding items and investigation of
  reconciliation differences.
- [HMRC guidance on disbursements](https://www.gov.uk/guidance/vat-costs-or-disbursements-passed-to-customers)
  distinguishes a true payment made as the client's agent from a cost of the
  firm's own service. A true disbursement is passed on at the exact amount and
  itemised separately; a recharge normally forms part of the firm's taxable
  supply.
- [HMRC VAT Notice 700](https://www.gov.uk/guidance/vat-guide-notice-700)
  requires a unique sequential invoice number, tax point and issue date,
  supplier and customer identities and addresses, descriptions, VAT treatment
  and totals. A credit note identifies the original bill and the reason and
  amount of the correction.
- [HMRC VAT rates](https://www.gov.uk/vat-rates) are represented explicitly as
  standard 20%, reduced 5%, zero-rated, exempt or outside scope. Exempt and
  outside-scope lines both calculate no VAT but remain different records.

The rules can change. These links and the assumptions below must be checked
again during the Finance security review and before production.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Currency | GBP only in the first version; every amount is an integer number of pence | Avoids floating-point errors and postpones exchange-rate accounting until it has a proper design |
| Financial truth | Posted records are insert-only. A mistake is reversed by a linked correcting record, never edited or deleted | Leaves the original, correction and actors answerable |
| Time | Staff record calendar date, whole minutes, a plain description and the rate that applies. Corrections reverse and replace the entry | Bills remain reproducible after a person's rate changes |
| Billing | Draft bills may change. Issuing creates a permanent numbered snapshot of every line, VAT treatment and total | A sent bill must not change underneath the client or ledger |
| Bill corrections | An issued bill is corrected by a credit note and, where needed, a new bill | Matches the insert-only financial record |
| Client and business money | Separate bank accounts, cash books and the two sides of each matter ledger | Makes the SRA separation visible and database-enforceable |
| Receipts | Accounts staff record a bank-confirmed receipt against one matter and purpose. Mixed or wrong allocations use explicit allocation/transfer records | No silent moving of money between clients or sides |
| Withdrawals | Every client-account withdrawal, including a refund, third-party payment or transfer for costs, is requested and approved by two different active `accounts` role holders | Applies the project owner's four-eyes decision consistently |
| Payment authority | A request records purpose, payee, bank details reference and supporting evidence on the matter. Approval checks that evidence and the live available balance | The approval answers what the money was for and what supported it |
| Bank execution | Approval reserves the amount. A different event records that the bank paid, rejected or cancelled it; Stass never claims approval itself moved money | Keeps workflow state separate from the external bank's truth |
| Reconciliation | Accounts prepares from imported statement lines; an active `compliance` holder signs off the fixed snapshot. Differences stay open until a later correction explains them | The existing compliance role represents COFA oversight and remains separate from accounts work |
| Bank connection | CSV statement import and manual bank references first; no Open Banking or payment initiation | Avoids giving an early system bank credentials or payment power |
| Visibility | Matter-team staff see time and issued bills for their own matters. `accounts` sees firm-wide finance needed for work; `compliance` sees firm-wide read-only records and signs reconciliations | A finance role may work across matters, while ordinary matter access remains narrow |
| Client portal | No finance pages in the first version | Bills and client ledgers need their own later portal privacy and delivery design |
| Retention | No deletion feature. The project-wide retention design will decide eventual disposal without rewriting posted records | Review item F3 remains open and should not be guessed inside Finance |

## Security and accounting rules

- PostgreSQL owns ids, sequence numbers, posting times and current workflow
  state. The application role cannot supply or rewrite trusted values.
- Posted time corrections, bills, credit notes, receipts, transfers, payment
  events, statement imports and reconciliations are permanent, including for
  the table owner. Drafts are the only mutable finance records.
- Money uses `bigint` pence with checked addition. PostgreSQL refuses zero,
  negative where not meaningful, or out-of-range amounts. TypeScript does not
  use JavaScript floating-point numbers for financial arithmetic or JSON
  serialisation.
- A posted transaction balances before commit. Client-bank postings and
  matter client liabilities move together; business-bank and business-ledger
  postings remain on the business side.
- A matter client ledger may not become negative. Approval reserves money, so
  two payments racing each other cannot both spend the same balance.
- A receipt, allocation, bill, costs transfer or payment names one client and
  matter. Database triggers recheck that relationship and take the relevant
  bank, matter and balance locks in a fixed order.
- New time and draft work are refused while a matter awaits conflict clearance
  or after it closes. Posted finance remains readable; bills, corrections,
  refunds and reconciliation may still be needed after closure.
- Client money may move to the business account for costs only against the
  unpaid amount of an issued bill or written costs notice, and only up to the
  unreserved balance held for that matter.
- A payment requester cannot approve their own request. Both actors must be
  different active staff accounts holding the `accounts` role at the moment of
  their action. Losing the role or being disabled takes effect immediately.
- Payee bank details are treated as secrets: encrypted at rest under a
  finance-specific key outside PostgreSQL, never returned in list responses,
  never written to audit or logs, and shown only for the approval/execution
  task that needs them.
- Statement files are parsed as data, never opened as spreadsheets or
  formulae. The stored import has a content hash, account id and row number so
  re-importing the same statement cannot duplicate money.
- Reconciliation sign-off stores the bank balance, cash-book balance,
  aggregate client liabilities, outstanding statement items, differences and
  their explanations as one immutable snapshot. Later corrections do not
  rewrite what was signed.
- Every finance query applies its record rule inside the database query.
  Possessing a permission alone does not expose another matter to a fee earner.
- Response schemas list every allowed field. Client addresses, bank details,
  private time descriptions and supporting documents do not leak into list
  responses, audit metadata, email or logs.

## Permissions

The first four permissions are built in step 14a, `bills.manage` in step 14b
and `client_money.record` in step 14c. The remaining permissions are added
only with their implementation step.

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---:|---:|---:|---:|---:|
| `time.record` - record and correct own time on a visible matter | | yes | yes | | |
| `finance.matter.view` - see time and issued bills on a visible matter | | yes | yes | yes | yes |
| `finance.view_all` - see firm-wide ledgers and finance work | | | | yes | yes |
| `bills.manage` - prepare, issue and credit bills | | | | yes | |
| `client_money.record` - record receipts, allocations and bank outcomes | | | | yes | |
| `client_money.request` - request a client-account withdrawal | | | | yes | |
| `client_money.approve` - approve another accounts holder's request | | | | yes | |
| `finance.reconcile` - import statements and prepare reconciliation | | | | yes | |
| `finance.reconciliation_sign_off` - sign a fixed reconciliation | | | | | yes |

The `administrator` role gains no finance access merely because it manages
accounts. A person may hold more than one role, but the database still requires
different people for request and approval.

## Records

The names can be refined during implementation, but the boundaries are fixed
by the design.

### Time and rates

- A rate record has a staff account, hourly pence rate, effective date and
  creator. Rates are never changed retrospectively.
- A time entry has matter, worker, work date, minutes, description, rate
  snapshot, recorder and database time.
- A correction links to the entry it reverses and, if applicable, its
  replacement. Billed time cannot simply be reused on another bill.

### Bills and credit notes

- A draft belongs to one matter and has fee, recharge and true-disbursement
  lines. Each line states its VAT treatment; Stass does not infer tax treatment
  from the word “disbursement”.
- Accounts supplies the firm's name, billing address and VAT registration on
  the draft because Stass does not yet have a firm-settings record. Issue
  refuses taxable lines without a VAT registration number. The operational
  deployment checklist must make these values part of controlled firm setup,
  rather than asking staff to retype them on every future screen.
- Issue assigns a database-serialised sequence number and snapshots its London
  issue date, the supplier and client names and addresses, client and matter
  references, lines, linked time facts, net, VAT and gross totals. The number
  is never reused.
- Delivery is a separate permanent event recording method and time. Email is
  not in the first version; staff can download the fixed bill for controlled
  delivery and record how it was provided.
- A credit note names the issued bill and the exact lines/amounts corrected.
  Crediting cannot exceed the uncredited amount.

### Bank, cash book and matter ledgers

- The bank-account register distinguishes client and business accounts and
  keeps opened/closed history. Account numbers are encrypted; lists show only
  a safe name and last four characters.
- A posted transaction has one immutable header and balanced postings. Each
  posting identifies client or business side, matter where applicable,
  amount, direction and purpose.
- The cash book is derived from bank postings. The matter ledger shows its
  client-money and business sides. Balances are computed from postings, never
  stored as caller-editable totals.

### Payment requests and approvals

- A request fixes bank account, matter, type, purpose, payee, amount,
  encrypted payment details, requester and evidence.
- Events are `approved`, `rejected`, `cancelled`, `paid` or `bank_rejected`.
  Only the allowed next event is accepted. An approval fixes the approver and
  reserves the amount; a terminal event releases any unused reservation.
- Recording `paid` posts the withdrawal under the same transaction. A costs
  transfer also reduces the bill's unpaid amount and posts the matching
  business-side receipt.

### Statements and reconciliations

- An import fixes the bank account, statement range, opening/closing balances,
  file hash, importer and rows. Duplicate files and duplicate rows are refused.
- Statement rows may be matched once to posted bank transactions. A mistaken
  match is reversed rather than overwritten.
- A prepared reconciliation contains the three required totals and every
  outstanding item/difference. Sign-off by Compliance makes it final.
- The dashboard warns before five weeks have passed and shows overdue
  reconciliations, but never marks one complete merely because time passed.

## Audit

Event families:

- `rate.created`, `time.recorded`, `time.corrected`, `bill.draft_created`,
  `bill.draft_updated`, `bill.issued`, `bill.credited`, `bill.delivered`,
  `bill.downloaded` and `bill.credit_downloaded` are built;
- `finance.bank_account_created`, `finance.bank_account_closed`,
  `finance.client_money_received`, `finance.business_money_received`,
  `finance.client_money_allocated` and `finance.business_money_allocated` are built;
- later payment events include `finance.client_money_payment_requested`,
  `finance.client_money_payment_approved`,
  `finance.client_money_payment_rejected` and `finance.client_money_paid`;
- `finance.bank_statement_imported`, `finance.bank_transaction_matched`;
- `finance.reconciliation_prepared`, `finance.reconciliation_signed_off`.

Audit metadata uses ids, event kinds, pence amounts and safe states. It does
not contain bank details, payee names, time descriptions, bill narratives,
statement text or supporting evidence. Each posted change and its audit event
share one database transaction. Refused self-approval and insufficient-funds
attempts are audited without storing the sensitive request body.

## API and screens

- Matter pages gain Time and Finance areas only when their API permissions and
  record visibility allow them.
- Accounts gets queues for draft bills, client receipts, payment requests and
  bank reconciliation. Compliance gets read-only ledgers and reconciliation
  sign-off.
- Totals are returned as decimal strings such as `"123.45"`, not JavaScript
  numbers. Dates are UK calendar dates and timestamps are UTC ISO strings.
- Rate and time lists use stable keyset paging. Exports are generated from
  fixed posted records, carry no spreadsheet formula cells and are audited.
- There are no client portal finance routes or screens in this version.

### Step 14a API

| Method | Path | Rule | Result |
|---|---|---|---|
| POST | `/finance/rates` | `rates.manage` | Create one permanent effective-dated rate for an active partner or fee earner |
| GET | `/finance/rates` | `finance.view_all` | List rates, optionally for one account, 100 at a time |
| POST | `/matters/:matterId/time-entries` | `time.record`, current team, open matter | Record the caller's own time using the database-selected effective rate |
| GET | `/matters/:matterId/time-entries` | `finance.matter.view`; current team unless `finance.view_all` | List safe summaries, newest first, 100 at a time. Descriptions and correction reasons are omitted |
| GET | `/time-entries/:entryId` | Same record rule as the list | Read one full entry and its permanent correction history |
| POST | `/time-entries/:entryId/corrections` | `time.record`, original worker, current team | Replace or void the caller's own entry. Closed matters may still be corrected |

Rates are decimal strings such as `"250.00"` at the boundary and integer pence
in PostgreSQL. A rate applies from its UK calendar date until a later rate.
Partners and fee earners record and correct only their own time on a matter
they can currently see. Accounts creates rates and, with Compliance, can read
finance across matters. The administrator role has no Finance permission.

PostgreSQL creates ids and times, chooses rate snapshots, locks matter closure
against new time, and rechecks live accounts, roles and team membership. The
application role cannot write the protected snapshot/history columns or edit,
delete or truncate posted records. The table owner is also stopped by triggers.
Correction rows keep the before and after values; a void keeps the original
entry and marks it void. An identical replacement creates no correction.

### Step 14b API

| Method | Path | Rule | Result |
|---|---|---|---|
| POST | `/matters/:matterId/bill-drafts` | `bills.manage`, open matter | Create a complete draft with supplier details and 1 to 100 fee, recharge or disbursement lines |
| GET | `/bill-drafts/:draftId` | `bills.manage` | Read a mutable draft; an issued draft is no longer returned as a draft |
| PUT | `/bill-drafts/:draftId` | `bills.manage` | Replace the complete draft before issue |
| POST | `/bill-drafts/:draftId/issue` | `bills.manage` | Create and return the permanent numbered bill snapshot |
| GET | `/matters/:matterId/bills` | `finance.matter.view`; current team unless `finance.view_all` | List safe issued-bill summaries, newest number first; descriptions and client details are omitted |
| GET | `/bills/:billId` | Same record rule as the list | Read one complete issued bill snapshot |
| POST | `/bills/:billId/credit-notes` | `bills.manage` | Issue a permanent numbered credit against named bill lines and their remaining balances |
| GET | `/credit-notes/:creditNoteId` | Same record rule as its bill | Read one complete credit note |
| POST | `/bills/:billId/deliveries` | `bills.manage` | Record how a bill was delivered; no message is sent |
| POST | `/credit-notes/:creditNoteId/deliveries` | `bills.manage` | Record how a credit note was delivered; no message is sent |
| GET | `/bills/:billId/content` | Same record rule as the bill | Download an audited fixed UTF-8 text rendering with safe attachment headers |
| GET | `/credit-notes/:creditNoteId/content` | Same record rule as the credit note | Download an audited fixed UTF-8 text rendering with safe attachment headers |

Bill line amounts are positive decimal strings up to `"1000000.00"`; all
arithmetic remains integer pence. VAT is 20% for standard, 5% for reduced and
zero for zero-rated, exempt and outside-scope lines, rounded to the nearest
penny per line. A final credit for a line takes its exact remaining VAT so
rounding cannot leave a penny behind.

Only an active Accounts holder can manage billing. Draft creation requires an
open matter, a non-future tax point, a due date on or after it, controlled
supplier details and, for taxable lines, a VAT registration number. Linked
time must be unvoided, belong to the matter and appear only on a fee line. An
existing draft may still be issued after matter closure.

PostgreSQL serialises bill and credit-note numbering and snapshots London issue
date, client and supplier identities and addresses, references, line facts,
linked time facts, VAT and totals. It locks linked time so one entry cannot be
billed twice and locks bills while crediting so concurrent credits cannot
exceed a line. The application cannot write billing tables directly. Once a
draft is issued, its source rows and every issued bill, credit note and delivery
row resist update, deletion and truncation even by the table owner.

### Step 14c API

| Method | Path | Rule | Result |
|---|---|---|---|
| POST | `/finance/bank-accounts` | `client_money.record` | Add a permanent client or business bank-account record; full details are encrypted before PostgreSQL and never returned |
| GET | `/finance/bank-accounts` | `finance.view_all` | List safe names, kinds, opening/closure dates and last four account-number digits |
| POST | `/finance/bank-accounts/:bankAccountId/close` | `client_money.record` | Add a permanent closure event; the register row is not edited |
| POST | `/finance/receipts` | `client_money.record` | Record one bank-confirmed client or business receipt and its two balanced postings |
| POST | `/finance/allocations` | `client_money.record` | Correct an allocation between two matters of the same client on one ledger side |
| GET | `/finance/matters/:matterId/ledger` | `finance.view_all` | Return derived client/business balances and 100 newest matter postings; `before` continues the list |
| GET | `/finance/bank-accounts/:bankAccountId/cash-book` | `finance.view_all` | Return the derived bank balance and 100 newest bank postings; `before` continues the list |

Accounts alone records bank accounts, receipts and allocations. Accounts and
Compliance can read the firm-wide bank register, cash books and matter
ledgers. Full sort codes and account numbers are AES-GCM encrypted under the
separate `FINANCE_ENCRYPTION_KEY`; list and change responses expose only the
safe name and last four digits, and audit contains neither.

PostgreSQL rechecks the live Accounts role, account and matter state. Receipts
derive their client/business side from the bank-account kind. Allocations lock
both matters in a stable order, require the same client and cannot take a
client ledger below zero. Bills and credit notes automatically add their
balanced business-ledger/control postings, including a migration backfill for
records issued in step 14b. All register, closure, transaction and posting
rows reject direct application writes and resist update, deletion and
truncation even by the table owner.

## Not in the first version

- Open Banking, bank credentials, bank payment initiation or automatic feeds.
- Multiple currencies, exchange gains/losses or foreign client accounts.
- Trust accounting, legal-aid claims, payroll, purchase ledger or a complete
  nominal/general ledger for statutory accounts.
- Automatic VAT return submission, Making Tax Digital or corporation tax.
- Interest calculation or alternative client-interest agreements. Stass will
  record an approved interest payment, but a later design must calculate what
  is fair.
- Joint accounts, a client's own account, third-party managed accounts, cash
  receipts or card processing.
- Client portal bills, online payment links, reminders or debt collection.

If the firm uses an excluded account or process, Stass must not present its
partial record as a compliant complete ledger.

## Build order

Every implementation step gets positive and negative tests, deliberate breaks
of each safeguard and updated documentation before the next step.

- **14a. Done.** Money and time primitives, permissions, immutable staff rates
  and time recording/correction API. Migration `0042`; implementation in
  `apps/api/src/finance/`. No bills or money movement yet.
- **14b. Done.** Draft bills, immutable issue snapshots, VAT/disbursement
  lines, credit notes, delivery records and fixed bill/credit-note downloads.
  Migration `0043`; API implementation in `apps/api/src/finance/`. No screens,
  client portal finance or money movement.
- **14c. Done.** Encrypted bank-account register, balanced client/business
  postings, matter ledgers, cash books, receipts and same-client allocation
  corrections. Migration `0044`; API implementation in
  `apps/api/src/finance/`. Withdrawals and bank outcomes remain step 14d.
- **14d.** Client-money payment requests, encrypted payee details, reservations,
  four-eyes approval and recorded bank outcomes, including billed-cost
  transfers.
- **14e.** Safe CSV statement import, transaction matching, five-week
  reconciliation preparation, Compliance sign-off and overdue status.
- **14f.** Staff matter-finance, Accounts and Compliance screens, exports and
  accessibility tests.
- Security review of Finance against the then-current SRA and HMRC rules.

## Approval

The project owner approved this design on 8 October 2026, including GBP-only
money, manual CSV statements and bank references, two different active
`accounts` role holders for every client-account withdrawal, `compliance`
sign-off of reconciliations, no client-portal finance in the first version and
the six-step build order above.

## Step 14a verification

- Positive tests cover exact pound/pence conversion without floating point,
  effective rates and snapshots, own-time recording, replacement and void
  corrections, correction after closure, Accounts and Compliance visibility,
  private detail access and stable 100-row paging.
- Negative tests cover malformed and excessive money, duplicate or ineligible
  rates, missing and future rates, invalid time and correction text, another
  worker, inactive accounts, lost roles or team access, awaiting and closed
  matters, repeated voiding, unknown input, client and missing sessions,
  caller-supplied protected values, direct changes, deletion and truncation.
- Transaction tests prove that rate, time and correction changes roll back
  with their audit event in both failure directions. Audit contains ids,
  minutes and pence only; private descriptions and correction reasons stay out.
- Controlled locking proves a matter closure and a new time entry cannot both
  win. Database tests run through both the application and owner roles.
- Seventeen deliberate break cases were run and restored. They proved the
  tests catch a missing permission mapping or route guard, a widened money
  bound, missing record visibility, private list or audit text, detached audit,
  missing rate creator/worker/team/role/status/future/effective-rate checks,
  missing closure locking and no-op suppression, widened database constraints
  or insert rights, and mutable rate, time or correction history.

## Step 14b verification

- Positive tests cover exact bill-money conversion, per-line VAT and rounding,
  draft creation and replacement, immutable issue snapshots and consecutive
  numbering, linked time facts, issue after closure, partial and final credits,
  delivery events, fixed bill and credit-note downloads, Accounts and
  Compliance visibility, matter-team visibility and private bill summaries.
- Negative tests cover missing permissions, unknown fields, malformed, zero or
  excessive amounts, dates, supplier and VAT details, line count and shape,
  foreign, void, reused or non-fee time, missing client address, repeated issue,
  over-crediting, duplicate or foreign credit lines, invalid reasons and
  deliveries, hidden records, direct table writes and every posted mutation.
- Transaction tests prove issue rolls back when its audit event fails. Audit
  uses ids, references, counts, delivery methods and pence totals; supplier and
  client addresses, line descriptions, credit reasons and delivery notes stay
  out. Downloads are audited and use no-store, nosniff, sandboxed attachment
  responses.
- Controlled concurrency tests prove two issue attempts cannot issue one draft,
  simultaneous different bills receive consecutive numbers, one time entry
  cannot be billed twice, and concurrent credits cannot exceed the remaining
  line balance. Database tests run through both application and owner roles.
- Twenty-two deliberate break cases were run and restored. They proved the
  tests catch a missing permission mapping or route guard, a widened bill-money
  bound, lost record visibility, leaked list or audit text, unsafe download
  headers, detached audit, missing Accounts/matter/date/supplier/VAT/line/time
  checks, direct application writes, mutable issued drafts or posted records,
  missing issue, numbering, linked-time or credit locks, incorrect VAT and
  final-penny credits, over-crediting and invalid delivery targets.

## Step 14c verification

- Positive tests cover authenticated bank-detail encryption, keyed duplicate
  detection, safe register fields, permanent closure, exact client/business
  receipts, same-client allocation corrections, automatic bill/credit
  postings, signed derived balances, allocation counterpart ids and stable
  100-row ledger/cash-book paging.
- Negative tests cover missing permissions, clients and non-Accounts staff,
  unknown input, malformed bank details, duplicate accounts and references,
  invalid dates, inactive or role-lost actors, awaiting-clearance matters,
  cross-client, same-matter and excessive client allocations, direct writes,
  unbalanced/mismatched postings and every owner mutation or truncation.
- Transaction tests prove receipts roll back when audit fails. Audit uses ids,
  kinds, dates, sides and pence only; bank names/details, references, purposes
  and allocation reasons stay out. Encryption tests prove random nonces and
  contexts, context-bound integrity and failure under another finance key.
- A controlled race holds the first allocation transaction open, proves the
  second waits on the ordered matter locks, then proves it sees the committed
  balance and is refused. Database tests run through application and owner
  roles.
- Thirty-one deliberate break cases were run and restored. They proved the
  tests catch missing permission mappings and route guards, loose input or
  paging, unsafe audit data or failure handling, broken encryption randomness,
  context binding, key use or keyed fingerprints, incorrect signed amounts or
  allocation counterpart ids, invalid audit actions, missing Accounts/date/
  duplicate/closure/matter/client/balance/posting checks, lost allocation
  locking, automatic posting, direct-write denial and owner immutability.
