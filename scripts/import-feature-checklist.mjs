// Imports the plain paragraph extraction of the owner's DOCX. The text is data.
// Re-run only when updating the baseline; subsequent acceptance lives in JSON.
import {readFile,writeFile} from 'node:fs/promises';
const base=new URL('../',import.meta.url);
const lines=(await readFile(new URL('docs/requirements/combined-checklist-source.txt',base),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/);
const code={
 architecture:['docs/architecture.md','docs/decisions.md'],auth:['apps/api/src/auth/permissions/permissions.ts','apps/api/src/auth/sessions/sessions.service.ts'],
 clients:['apps/api/src/clients/clients.controller.ts','apps/api/src/clients/clients.repository.ts'],
 matters:['apps/api/src/matters/matters.controller.ts','apps/api/src/matters/matters.repository.ts'],
 workspace:['apps/api/src/workspace/workspace.service.ts','apps/web/src/components/workspace-toolbar.tsx'],
 timer:['apps/api/migrations/0081_durable_work_timers.sql','apps/api/src/workspace/work-timer.service.ts','apps/web/src/components/workspace-timer.tsx','apps/api/src/workspace/workspace.controller.spec.ts'],
 finance:['apps/api/src/finance/finance.service.ts','apps/api/src/finance/finance.controller.ts'],
 ledger:['apps/api/migrations/0044_finance_ledgers.sql','apps/api/src/finance/payment.service.ts','apps/api/src/finance/reconciliation.service.ts'],
 documents:['apps/api/src/documents/documents.service.ts','apps/api/src/documents/documents.repository.ts'],
 tasks:['apps/api/src/tasks/tasks.service.ts','apps/api/src/notifications/task-reminder.service.ts'],
 onboarding:['apps/api/src/onboarding/onboarding.service.ts','apps/api/src/onboarding/onboarding.repository.ts'],
 compliance:['apps/api/src/compliance/compliance.service.ts','apps/api/src/compliance/compliance.repository.ts'],
 screening:['apps/api/src/compliance/sanctions-screening.service.ts','apps/api/src/compliance/sanctions.service.ts'],
 ai:['apps/api/src/ai/ai.service.ts','apps/api/src/ai/citation-grounding.service.ts'],
 reports:['apps/api/src/compliance/restricted-reports.service.ts','apps/api/src/compliance/retention.service.ts'],
 audit:['apps/api/src/audit/audit.service.ts','apps/api/migrations/0001_audit_events.sql'],
 deployment:['docs/deployment.md','docs/disaster-recovery.md','.github/workflows/ci.yml'],
};
const groups=[
 [1,8,'architecture','partial','Verify the complete shared architecture and clean setup; add missing capabilities.'],
 [9,16,'auth','partial','Verify single-firm staff/client isolation and role enforcement; shared-database tenants are outside the approved scope.'],
 [17,24,'clients','partial','Extend the client directory into contact/intake CRM and verify conflict review.'],
 [25,32,'matters','partial','Complete workspace details and verify the joined matter lifecycle.'],
 [33,40,'workspace','partial','Verify responsive navigation, real metrics, timezone behavior and failure states.'],
 [41,48,'timer','partial','Run timer and finance acceptance, including browser reload, simultaneous tabs and date-specific rate rounding.'],
 [49,56,'finance','partial','Complete bill balances, fee models, PDF export and provider-backed settlement.'],
 [57,64,'ledger','present_unverified','Rerun ledger/payment/reconciliation acceptance and obtain professional finance review.'],
 [65,72,'documents','partial','Verify private versioned storage; complete automation, editing and text-processing gaps.'],
 [73,80,'tasks','partial','Complete shared calendars, workflow/deadline templates and communication capture.'],
 [81,88,'workspace','partial','Complete target/revenue reporting and the exact labelled sample dataset.'],
 [89,96,'onboarding','partial','Verify unified onboarding and extend generated CDD evidence requirements.'],
 [97,104,'compliance','partial','Add approved obligation/risk-rule versions and independently reproducible scoring.'],
 [105,112,'compliance','partial','Build persisted challenges, evidence-linked answers and backend sign-off gates.'],
 [113,120,'ai','partial','Join manual/AI rationale statements to facts and the exact compliance sign-off.'],
 [121,128,'compliance','missing','Implement complete version-bound snapshots, deterministic chains, external anchors and independent export verification.'],
 [129,136,'compliance','partial','Complete exception reporting and controlled incident/complaint registers.'],
 [137,144,'reports','partial','Verify restricted MLRO/SAR workflow and professionally reviewed clock semantics.'],
 [145,152,'onboarding','missing','Build each approved practice pack on shared evidence and rules; do not claim professional accreditation.'],
 [153,160,null,'external','Owner to decide whether platform subscription commerce applies to this single-client deployment and approve pricing before implementation.'],
 [161,168,null,'external','Provider selection intentionally open per owner; retain requirement and document adapters, permissions, retries and verification.'],
 [169,176,'audit','present_unverified','Run current validation/security and the complete practice-finance-compliance acceptance flow.'],
 [177,184,'deployment','present_unverified','Rerun release/deployment, restore/load and handover checks for this version.'],
 [185,192,null,'external','Record client-specific pilot, independent professional/security review and final acceptance evidence.'],
];
const overrides=new Map();
function set(ids,status,area,nextAction){for(const id of ids)overrides.set(id,{status,codeEvidence:area?code[area]:[],nextAction});}
set([1,4,5,8],'present_unverified','architecture','Confirm the existing modular API, shared records and documented local setup against this checklist.');
set([7],'partial','architecture','Practice, finance, document and AML modules exist; add dedicated risk-rule, challenge, sealed-evidence and integration modules.');
set([2],'partial','workspace','Next.js, TypeScript, Tailwind and SVG icons exist; verify chart-library requirement and clean local startup.');
set([3],'partial','architecture','PostgreSQL and versioned JSON exist. The established ORM is Kysely; retain its protected SQL functions and record the Prisma requirement as an unresolved architecture difference.');
set([6],'missing',null,'Add authenticated live updates with record-level authorization, reconnect and revoked-access tests; existing polling is not WebSockets.');
set([10,11,16],'present_unverified','auth','Rerun sign-in/recovery/MFA/session and granular-role tests for this integrated version. Existing compliance role represents MLRO/COLP oversight with separate nominated-officer appointments.');
set([12,13,14,15],'approved_exclusion','auth','Owner confirmed on 31 October 2026 that this installation is for one client law firm. Shared-database Firm A/Firm B tenancy is excluded; retain staff, team and client-portal authorization regression checks.');
set([17,18],'partial','clients','People/organisations and client contacts exist; add independent lead/expert/contact records without requiring a client record.');
set([19],'partial','onboarding','Duplicate review exists in onboarding/conflicts; add an explicit safe merge with reference preservation and audit.');
set([20],'partial','matters','Matter parties exist; add reusable typed person/company relationships across the contact directory.');
set([21],'partial','onboarding','Onboarding exists; add lead capture, acceptance and conversion with history.');
set([22,23,24,25,26,27,29,30,31],'present_unverified','matters','Verify current matter/conflict/party lifecycle and permissions against the exact requirement.');
set([28],'missing',null,'Add validated practice-area custom-field definitions and matter templates, preserving historical values.');
set([32],'partial','matters','Matter work, documents, tasks and clearance exist; add challenge and sealed-decision views in the same matter.');
set([33,34,36,37,40],'present_unverified','workspace','Verify keyboard/mobile behavior, permissions and loading/empty/error states in current browser acceptance.');
set([35],'partial','workspace','Core navigation exists; add working Communications, Payments and Integrations workspaces as their services are implemented.');
set([38],'partial','workspace','Agenda exists; appointments currently use Europe/London. Store a user timezone and test local-day boundaries.');
set([39],'partial','workspace','Hours and weekday target preferences exist; verify period targets and billable versus nonbillable classification.');
set([41,42,43,44],'present_unverified','timer','Server-backed start/pause/resume/reset, timestamp elapsed time, revision conflicts and persistent state implemented. API integration tests pass; add browser reload, multiple-tab and device acceptance evidence.');
set([45],'partial','finance','Time records retain worker, matter, date, minutes, rate and description; add an explicit billable flag and reviewed migration for existing entries. Firm tenant IDs are excluded.');
set([46],'present_unverified','finance','Verify correction/void history and billed versus unbilled entry behavior.');
set([47],'present_unverified',null,'Expense records, fixed receipt references, billable classification, void history and duplicate-safe invoice linkage exist. Verify against current API/database and browser acceptance. UTBMS/LEDES remain unselected.');
set([48],'partial','timer','Concurrent consume/retry tests pass; verify round-up boundaries, historical rate changes and manual minute adjustments with finance tests.');
set([49],'partial','finance','Hourly/manual fee lines exist; add agreed fixed-stage and contingency fee model configuration and calculations.');
set([50,51],'partial','finance','Draft/issue/credit workflows exist; verify expense inclusion, pre-bill edits, write-off reasons and duplicate-source protection.');
set([52,55,56],'partial','finance','Issued totals exist; add bill-level settlement/allocation, unpaid/overdue balances and refund/retry handling.');
set([53],'missing',null,'Generate an authorized invoice PDF from the immutable issued-bill snapshot.');
set([54],'external',null,'Payment processor intentionally undecided. Implement and test hosted checkout and signed idempotent webhooks once selected.');
set([64],'partial','ledger','Reconciliation and independent sign-off code exist; run current acceptance and obtain the required professional review.');
set([65,67,69],'present_unverified','documents','Verify private encrypted versioned storage, evidence references and authorized previous-version access.');
set([66],'partial','documents','Authenticated streamed downloads exist; implement scoped expiring download tokens if signed-link behavior is retained as a requirement.');
set([68],'partial','documents','Document title/category lists exist; complete folders/tags and full requested search behavior.');
set([70,71,72],'missing',null,'Add document checkout/concurrent-edit policy, general DOCX/PDF merge templates, OCR, full-text index, PDF merge and bundle verification. Engagement templates alone do not complete this check.');
set([73],'present_unverified','tasks','Verify task assignments, due dates, priorities and complete/reopen history.');
set([74],'partial','workspace','Private timed appointments exist; add attendee/team sharing, explicit timezone and durable reminders.');
set([75,77,78],'missing',null,'Add versioned workflow/milestone/deadline rules with approved source, review, date-boundary and timezone tests.');
set([76],'present_unverified','tasks','Verify durable task reminder jobs, retries and safe failure visibility.');
set([79,80],'partial','matters','Matter history and notifications exist; add calls, notes, filed email and secure matter communications, excluding restricted reports.');
set([81,88],'partial','workspace','Recorded-time value metrics exist; separate billable production, billed revenue and collected revenue and document each basis.');
set([82],'partial','workspace','Indexes, pagination and earlier load evidence exist; measure the current release and new report paths.');
set([83,84,85,86,87],'missing',null,'Add annual target/actual chart and matching table plus isolated, clearly labelled exact-value sample fixtures; never fabricate live dashboard amounts.');
set([89,90,91,93,95],'present_unverified','onboarding','Verify shared onboarding, person/company paths, beneficial ownership, source conclusions and approved engagement content.');
set([92,94],'partial','compliance','CDD cases/evidence/measure results exist; generate requirements from approved risk rules and expose requested/collected/assessed/accepted/rejected/missing states.');
set([96],'partial','onboarding','Verification evidence/provider outcomes can be recorded; selected live identity-provider integration remains open.');
set([97,98,99],'missing',null,'Implement approved versioned obligation catalogue and attributable deterministic engine scoring; document real practice-area coverage without assuming the source demonstration is delivered.');
set([100,104],'external','compliance','Qualified firm reviewer must approve triggers, floors and changed regulatory content. Retain current controls pending review; do not activate speculative rules.');
set([101],'partial','screening','Official UK sanctions list imports/matching exist; PEP provider is intentionally undecided and remains open.');
set([102],'present_unverified','screening','Verify unknown/failed/matched screening remains reviewable and cannot become implicit clearance.');
set([103],'partial','compliance','Immutable controls/country-list/risk versions exist; add independently executable historical scoring-rule versions.');
set([105,106,107,108,109,110],'missing',null,'Add deterministic comparison and combination/evidence challenges, immutable linked answers, named override/escalation and transactional backend/UI sign-off blocking.');
set([111],'partial','compliance','Separate senior/partner approvals exist; define and implement the qualified sole-practitioner review route without claiming independent self-review.');
set([112],'present_unverified','compliance','Verify existing PostgreSQL-enforced work/money clearance gates, material-change invalidation and preserved assessment history.');
set([113,114,117,118],'partial','ai','Citation grounding and human approval exist for AI outputs; join compliance narrative statements to exact facts/evidence and final approved decision versions.');
set([115,119,120],'present_unverified','ai','Rerun AI authorization, redaction, provider-failure, prompt-injection, budget and manual-fallback tests; record provider retention/location settings before connection.');
set([116],'partial','compliance','Manual risk narratives and clearance exist; implement the same challenge, statement-citation and decision-seal flow without requiring AI.');
set([121,122,123,125],'partial','compliance','Immutable encrypted assessments, evidence hashes, result references and transactional clearances exist; a complete unified signed decision snapshot/sealing path is still required.');
set([124,126,127,128],'missing',null,'Build canonical cryptographic decision chaining, trusted external anchoring, adversarial replacement/truncation tests and a readable independently verifiable PDF/data export.');
set([129,130,131,132],'partial','compliance','Review queues, holds and notifications exist; add joined compliance metrics including challenge/override/outcome reporting and daily exception summaries.');
set([133],'partial','reports','Restricted suspicion reporting exists; add controlled breach and complaint incident registers with ownership/follow-up.');
set([134,135],'present_unverified','compliance','Verify restricted-information exclusion and existing partner-approved firm-wide risk/policy version workflows.');
set([136],'approved_exclusion','auth','Owner selected one client law firm per installation. Cross-firm analytics is excluded; do not pool client data from separate installations.');
set([137,138,139,140,141],'present_unverified','reports','Verify confidential internal reporting, nominated-officer access, decisions and manually recorded NCA references; no automatic external filing is claimed.');
set([142,143,144],'partial','reports','Restricted DAML/hold records exist; review source-backed clocks, pauses/extensions, access and end-to-end MLRO workflow before enabling automated calculations.');
set([149,150],'partial','onboarding','Company verification records exist; complete provider-neutral Companies House/filed-account/research check workflow with source dates and uncertainty.');
set([151,152],'external',null,'Retain later practice packs in target scope; obtain supported-practice/rule approval before releasing each pack.');
set([161],'external',null,'Internal modules already share records; external Clio/LEAP import/sync remains an open provider decision, with no fake connection status.');
set([169,170,171,172,173,177,178,179],'present_unverified',null,'Rerun current audit/input/upload/configuration/CI/migration acceptance; historical reports are supporting references, not new test results.');
set([174,175,176,180,181,182,183],'partial','deployment','Run this release against dependency/security, full joined workflow, hosting/TLS, restore, realistic load and rollback/support requirements; retain external review as open.');
set([184],'external',null,'Complete firm staff guidance and obtain client acceptance with every remaining item visible.');

let section='';const items=[];
for(let i=0;i<lines.length;i++){
 if(/^\d{1,2} [A-Za-z]/.test(lines[i]))section=lines[i].trim();
 if(!/^\d{3}$/.test(lines[i]))continue;
 const id=Number(lines[i]),group=groups.find(([from,to])=>id>=from&&id<=to);
 if(!group)throw new Error(`Unknown requirement ${id}`);
 const requirement=lines.slice(i+1).find(line=>line.trim()&&line.trim()!=='☐');
 const [, ,area,status,nextAction]=group;
 const item={id:String(id).padStart(3,'0'),section,requirement,status,codeEvidence:area?code[area]:[],nextAction,
  owner:'implementation team',acceptanceEvidence:[],verifiedAt:null,...overrides.get(id)};
 if(item.status==='external'||item.status==='approved_exclusion')item.owner='firm owner / provider / independent reviewer';
 items.push(item);
}
const output={sourceDocument:'Combined_Clio_LEAP_Reglify_Checklist.docx',reviewedOn:'2026-10-31',scope:'Single client law firm per installation. External providers undecided; retain integration requirements as open. All other source items remain in target scope.',scopeDecisionEvidence:'Owner reply in this session, 31 October 2026',items};
await writeFile(new URL('docs/requirements/combined-feature-checklist.json',base),JSON.stringify(output,null,2)+'\n');
console.log(`Imported ${items.length} requirements`);
