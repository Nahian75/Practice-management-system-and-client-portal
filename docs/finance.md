# Finance

**Current state (2026-10-08):** First-version design approved by the project
owner. Step 14a is built: exact GBP money strings, immutable staff rates and
time entries, permanent corrections, permissions, audit and the staff API.
There are no bills, client-money records or Finance screens yet.

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

The first four permissions are built in step 14a. The remaining permissions
are added only with their implementation step.

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
- Issue assigns a database sequence number and snapshots the client and matter
  reference, lines, net, VAT and gross totals. The number is never reused.
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

- `rate.created`, `time.recorded`, `time.corrected` are built;
- `bill.issued`, `bill.delivered`, `bill.credited`;
- `client_money.received`, `client_money.allocated`,
  `client_money.payment_requested`, `client_money.payment_approved`,
  `client_money.payment_rejected`, `client_money.paid`;
- `bank_statement.imported`, `bank_transaction.matched`;
- `reconciliation.prepared`, `reconciliation.signed_off`.

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
- Lists use stable keyset paging. Exports are generated from fixed posted
  records, carry no spreadsheet formula cells and are audited.
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
- **14b.** Draft bills, immutable issue snapshots, VAT/disbursement lines,
  credit notes, delivery records and bill download.
- **14c.** Encrypted bank-account register, balanced client/business postings,
  matter ledgers, receipts and allocation corrections.
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
