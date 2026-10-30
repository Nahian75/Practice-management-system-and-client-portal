# Practice Management System: production engineering, QA and security master checklist

Prepared: 2026-10-30. Status: **verification in progress; no production sign-off**. Every checkbox starts unchecked; this document does not certify this repository or any hosting provider.

Verification has started: see the [first local audit report](reviews/2026-10-30-production-readiness-audit.md) and [per-control status register](reviews/2026-10-30-production-readiness-controls.csv). Checkboxes remain unchecked until the complete requirement and its closure evidence are reviewed; a partial local test is not production sign-off.

Implementation progress: [security remediation and current release gates](reviews/2026-10-30-security-remediation.md).

Scope: client records, staff/client access, scheduling, billing, telehealth, documents, integrations and production operations. Apply clinical items only when delivering healthcare; apply legal-practice obligations where relevant. Record an approved reason for every non-applicable control, including unused technologies such as GraphQL, NoSQL, OAuth or Kubernetes.

## How to use and import

Use the seven numbered sections as epics, subsections as modules and checkbox IDs as tasks. GitHub issue bodies support Markdown task lists; Notion can import Markdown, although checkbox conversion may need adjustment. Jira does not universally convert Markdown checkboxes into issues: use the companion `pms-production-master-checklist-jira.csv`, map Summary, Description, Issue Type, Priority and Labels, and check field compatibility in your Jira project. The CSV creates independent tasks; establish epic/parent links after importing. Re-importing can create duplicates unless you map an existing issue key or deduplicate by control ID.

CSV defaults: issue type `Task`, P0 maps to `Highest`, P1 maps to `High`, and labels identify the numbered section. Map these values to your project's configured issue types and priorities during import. Import a small sample first; keep all tasks open until evidence is reviewed.

**P0:** applicable control must pass before production. **P1:** complete before production unless the accountable owner approves a documented, time-limited exception with compensating controls. These are proposed release priorities, not vulnerability severity ratings or statutory classifications.

**Definition of done for each task:** assign an owner; record applicability, acceptance criteria and environment; attach a passing test/configuration review or exercise result; link commit/build and execution date; obtain reviewer approval. A screenshot or scanner success alone is not evidence for authorization, integrity or compliance.

Suggested issue fields: `Control ID | Section | Module | Owner | Priority | Applicability | Acceptance criteria | Evidence | Build | Reviewer | Exception/expiry`. Keep real client data, credentials and exploit evidence out of public tickets.

**Policy values to resolve before signing off:** password/OTP/reset/invitation limits and lifetimes; idle/absolute sessions; access/refresh-token lifetime and revocation delay; payload/upload/archive-expansion limits; malware-signature freshness; endpoint/tenant rate limits; worker timeouts/retries; p95/p99 performance and concurrency targets; alert response targets; retention; RPO/RTO; and vulnerability-remediation deadlines. Record numeric values, rationale and owners in the release evidence rather than leaving them as unspecified defaults.

Baseline: use [OWASP ASVS 5.0.0](https://asvs.owasp.org/) as the detailed verification catalogue, target Level 2 and assess Level 3 controls for the highest-risk functions. Map the [OWASP Top 10:2025](https://top10.owasp.org/2025/) and [API Security Top 10:2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/) into the backlog; awareness lists alone are not an acceptance standard.

## 1. Threat Modeling & Hacker Attack Surface Defense

### 1.1 Scope, assets and abuse cases

- [ ] **THR-001 | P0** Inventory domains, routes, APIs, admin consoles, WebSockets, uploads, webhooks, workers, object stores and third parties; name each owner and exposure.
- [ ] **THR-002 | P0** Diagram data flows and trust boundaries from browser through API, database, queue, storage, video and payment providers; include backups and support access.
- [ ] **THR-003 | P0** Classify client identity, medical/legal records, finance, credentials and metadata; define confidentiality, integrity, availability and retention requirements.
- [ ] **THR-004 | P0** Model external attackers, compromised clients, malicious employees, tenant administrators, vendors and stolen service credentials; document assets each could reach.
- [ ] **THR-005 | P0** Threat-model each critical workflow: account recovery, record sharing, document processing, booking, refunds, exports and telehealth admission.
- [ ] **THR-006 | P0** Assign risk owners and mitigation deadlines; map threats to tests and controls, including current OWASP supply-chain and exceptional-condition risks.
- [ ] **THR-007 | P1** Repeat threat review after material architecture, vendor, tenant-boundary or privilege changes; track newly introduced attack surfaces.

### 1.2 Injection, execution and access abuse

- [ ] **THR-008 | P0** Bind SQL values through parameterized queries; allowlist dynamic identifiers and sort directions; test ORM escape hatches and raw queries.
- [ ] **THR-009 | P0** If using NoSQL, validate typed query inputs and reject user-controlled operators, executable expressions and arbitrary database selectors.
- [ ] **THR-010 | P0** Verify contextual output encoding for HTML, attributes, URLs and scripts; test stored, reflected and DOM XSS in notes, names and previews.
- [ ] **THR-011 | P0** Protect cookie-authenticated state changes against CSRF using verified tokens/origins and suitable SameSite settings; reject state-changing GET requests.
- [ ] **THR-012 | P0** Block SSRF to loopback, private/link-local addresses and cloud metadata; validate IPv4/IPv6 destinations, DNS resolution and every redirect.
- [ ] **THR-013 | P0** Restrict outbound destinations and protocols; ensure document renderers, URL previews and importers cannot retrieve internal services or local files.
- [ ] **THR-014 | P0** Remove dynamic evaluation and unsafe deserialization; pass subprocess arguments without shell interpolation; sandbox unavoidable converters with resource and network limits.
- [ ] **THR-015 | P0** Prevent path traversal, archive extraction escapes, symlink abuse, XML external entities and server-side template injection in all import/preview flows.
- [ ] **THR-016 | P0** Reject mass assignment and prototype-pollution keys; server owns role, tenant, owner, billing status and approval fields.
- [ ] **THR-017 | P0** Test IDOR/BOLA across read, edit, delete, download, search, nested records and bulk operations; UUIDs alone never authorize access.
- [ ] **THR-018 | P0** Validate Host and forwarded headers against trusted proxies; test request-smuggling ambiguities, open redirects and shared-cache poisoning.
- [ ] **THR-019 | P0** Fail closed on authorization, validation and key errors; force transactional rollback and generic client errors without exposing stack traces.

### 1.3 Abuse resistance and resource limits

- [ ] **THR-020 | P0** Configure distributed rate limits by account, tenant, endpoint and trusted client IP; verify limits across multiple instances and alternate routes.
- [ ] **THR-021 | P0** Throttle login, OTP, recovery, invitations, search, exports and paid integrations; implement progressive delays and bounded temporary lockouts.
- [ ] **THR-022 | P0** Test account-lockout denial of service and username enumeration; avoid permanent attacker-triggered lockouts and revealing account-existence responses.
- [ ] **THR-023 | P1** Add risk-triggered CAPTCHA or equivalent bot challenges with an accessible fallback; verify bots cannot simply bypass the challenged endpoint.
- [ ] **THR-024 | P0** Deploy edge DDoS protection and origin restrictions; verify direct origin access cannot bypass WAF, throttling or request limits.
- [ ] **THR-025 | P0** Enforce explicit JSON, multipart, header, URL, file-count and decompressed-size limits at edge and API; document necessary differences.
- [ ] **THR-026 | P0** Bound pagination, query complexity, regex execution, database timeouts, worker concurrency and per-tenant quotas; test expensive authenticated requests.
- [ ] **THR-027 | P0** Test slow uploads, disconnects, queue saturation and vendor retry storms; enforce timeouts, cancellation, backpressure and spending ceilings.

### 1.4 Input and upload boundary

- [ ] **THR-028 | P0** Validate server-side schemas, lengths, ranges, enums and business rules; handle unknown fields, duplicate keys, malformed encodings and Unicode consistently.
- [ ] **THR-029 | P0** Preserve valid names and free text; use purpose-specific sanitization and output encoding instead of deleting punctuation or relying on blacklist filters.
- [ ] **THR-030 | P0** Allowlist upload extensions and verify declared MIME against file signatures and safe parsing; reject mismatches, polyglots and unsupported encrypted archives.
- [ ] **THR-031 | P0** Quarantine uploads until malware scanning succeeds; reject or hold files when scanning fails, times out or signatures exceed the freshness policy.
- [ ] **THR-032 | P0** Bind scan approval to immutable object bytes/version; prevent replacement between scanning, previewing and release; test with safe antivirus test files.
- [ ] **THR-033 | P0** Generate storage keys server-side, keep files outside executable/web roots and use private storage; never treat filenames as filesystem paths.
- [ ] **THR-034 | P0** Isolate PDF/image/office processing; cap archive expansion, memory and CPU; sanitize active content or render inert previews on an isolated origin.

Guidance: [input validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html), [SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) and [file upload security](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

## 2. Authentication, Authorization & Session Hardening

### 2.1 Accounts, passwords and recovery

- [ ] **AUTH-001 | P0** Define staff invitation, client invitation and any self-registration flows; public registration cannot select staff roles or join an arbitrary practice.
- [ ] **AUTH-002 | P0** Bootstrap the first administrator through a controlled, single-use process; remove default accounts and disable bootstrap privileges after completion.
- [ ] **AUTH-003 | P0** Make invitations unpredictable, hashed at rest, expiring, revocable and single-use; bind tenant, recipient and allowed role server-side.
- [ ] **AUTH-004 | P0** Verify email ownership; test duplicate accounts, case/Unicode normalization and address changes without incorrectly merging distinct identities.
- [ ] **AUTH-005 | P0** Require long passwords; suggested policy is 15 characters minimum with at least 64 supported, no silent truncation and compromised-password blocking.
- [ ] **AUTH-006 | P0** Permit password managers and paste; avoid arbitrary composition rules, security questions and routine forced password changes without compromise evidence.
- [ ] **AUTH-007 | P0** Hash passwords with calibrated Argon2id and unique salts; where validated cryptography is required, select an approved supported alternative and document parameters.
- [ ] **AUTH-008 | P0** Rehash on successful login when parameters change; test password-verification resource exhaustion and never log plaintext passwords or reusable hashes.
- [ ] **AUTH-009 | P0** Return generic recovery responses; store only hashed, short-lived, single-use reset tokens and prevent replay, token leakage and reset-host poisoning.
- [ ] **AUTH-010 | P0** Test recovery emails through the real production mail path, expiry and bounce handling; resets revoke affected sessions and notify the account owner.
- [ ] **AUTH-011 | P0** Define identity-verified support recovery for lost email/MFA; require approval and audit, with no universal bypass or employee-accessible password retrieval.

### 2.2 MFA and federated identity

- [ ] **AUTH-012 | P0** Enforce MFA for staff and administrators, including backup/owner accounts; define appropriate client and high-risk-action MFA requirements.
- [ ] **AUTH-013 | P1** Offer phishing-resistant passkeys/security keys; validate WebAuthn RP ID, origin, challenge expiry, user verification and challenge single use.
- [ ] **AUTH-014 | P0** Encrypt TOTP secrets separately from password hashes; reject reused codes, bound clock skew and throttle verification/enrollment attempts.
- [ ] **AUTH-015 | P0** Hash recovery codes, show them only during generation and consume them atomically; regenerating codes invalidates the previous set.
- [ ] **AUTH-016 | P0** Require recent authentication for MFA reset, factor enrollment and email changes; notify users and invalidate relevant sessions after recovery.
- [ ] **AUTH-017 | P0** If using SSO, use OIDC for authentication and authorization-code flow with PKCE; reject implicit/password grants and arbitrary redirect URIs.
- [ ] **AUTH-018 | P0** Validate OIDC issuer, audience, signature, nonce and callback state; prevent account-linking takeover, login CSRF and attacker-selected identity providers.
- [ ] **AUTH-019 | P0** Test SSO deprovisioning, provider outage and emergency access; do not silently bypass MFA or grant access during federation errors.

### 2.3 RBAC/ABAC and privilege boundaries

- [ ] **AUTH-020 | P0** Build an explicit role/action/resource/field matrix for staff, clients, finance, practitioners, support and tenant administrators; deny unspecified access.
- [ ] **AUTH-021 | P0** Combine roles with tenant, record membership, assignment and sensitivity attributes; evaluate authorization on every server-side operation.
- [ ] **AUTH-022 | P0** Test BFLA by calling administrative, approval, export and bulk endpoints directly with client and lower-privilege sessions.
- [ ] **AUTH-023 | P0** Test response-field permissions, overposting and nested relationship changes; unauthorized data cannot leak through serialization or error messages.
- [ ] **AUTH-024 | P0** Recheck current privileges after suspension, role changes and matter/client reassignment; stale claims, caches and background jobs cannot preserve access.
- [ ] **AUTH-025 | P0** Separate approvals for refunds, bank changes and privileged role grants; prohibit self-approval where segregation of duties is required.
- [ ] **AUTH-026 | P0** Make support impersonation/break-glass access explicit, time-limited and independently logged; verify tenant scope, approval and automatic expiry.

### 2.4 Sessions and tokens

- [ ] **AUTH-027 | P0** Choose opaque server sessions or tokens based on architecture; document expiry, revocation and threat tradeoffs rather than requiring JWTs everywhere.
- [ ] **AUTH-028 | P0** Set session cookies HttpOnly and Secure with narrow scope; use host-only/__Host- cookies where possible and prevent conflicting cookie names.
- [ ] **AUTH-029 | P0** Use SameSite=Strict where flows permit; test Lax or narrowly scoped None;Secure exceptions for external sign-in/payment flows alongside CSRF protections.
- [ ] **AUTH-030 | P0** Generate high-entropy sessions and rotate identifiers after login, MFA and privilege elevation; old identifiers fail fixation and replay tests.
- [ ] **AUTH-031 | P0** Enforce server-side idle and absolute timeouts plus recent-authentication windows; client activity cannot extend sessions indefinitely.
- [ ] **AUTH-032 | P0** Provide logout and revoke-all-devices; test password reset, account disablement and security events invalidate access within the documented revocation window.
- [ ] **AUTH-033 | P0** If using JWTs, allowlist algorithms/keys and validate issuer, audience, expiry and token purpose; reject none, key confusion and wrong token types.
- [ ] **AUTH-034 | P0** If using refresh tokens, rotate atomically, detect reuse and revoke the token family; test concurrent refresh and stolen-token scenarios.
- [ ] **AUTH-035 | P0** Implement bounded token revocation via session versions, introspection or a denylist; prove the approach works across all application instances.
- [ ] **AUTH-036 | P1** Provide a session/device list and unusual-login alerts; assess concurrent sessions without treating changing IP addresses as proof of compromise.
- [ ] **AUTH-037 | P0** Keep credentials and bearer/refresh tokens out of URLs, logs and persistent browser storage; restrict token exposure to the intended client.
- [ ] **AUTH-038 | P0** Test expiry and revocation on WebSockets, streaming endpoints, downloads and mobile clients; reconnection cannot restore withdrawn privileges.

References: [NIST SP 800-63B-4](https://csrc.nist.gov/pubs/sp/800/63/B/4/final), [password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html), [authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The 15-character policy above is a proposed application baseline; applicable assurance requirements still need review.

## 3. Architecture & Multi-Tenant Data Isolation

### 3.1 Tenant and service architecture

- [ ] **ARCH-001 | P0** Record architecture decisions for a modular monolith or services, tenant isolation, regional hosting and identity; assign an owner to every boundary.
- [ ] **ARCH-002 | P0** Choose database-per-tenant, schema-per-tenant or shared tables deliberately; document isolation guarantees, migrations, restores and operational limitations.
- [ ] **ARCH-003 | P0** Resolve tenant membership from authenticated server-side context; reject arbitrary tenant headers, URL IDs and subdomains without membership verification.
- [ ] **ARCH-004 | P0** Make tenant ownership mandatory where appropriate; use tenant-aware uniqueness and foreign keys to prevent cross-tenant parent/child associations.
- [ ] **ARCH-005 | P0** For shared-table RLS, define read/write policies and appropriate FORCE ROW LEVEL SECURITY; deny missing or invalid tenant context.
- [ ] **ARCH-006 | P0** Run the application without superuser, table-owner or BYPASSRLS privileges; separate migration, runtime, reporting and backup roles.
- [ ] **ARCH-007 | P0** Test RLS bypass risks in views, security-definer functions and pooled connections; clear transaction-local tenant state between requests.
- [ ] **ARCH-008 | P0** Test tenant A versus tenant B in APIs, joins, counts, search, exports, storage paths, caches, analytics, queues and video rooms.
- [ ] **ARCH-009 | P0** Scope cache keys, invalidation events, object keys and signed URLs to tenants and users; prove identical record IDs cannot collide across tenants.
- [ ] **ARCH-010 | P0** Keep tenant context authoritative across asynchronous work and retries; workers recheck current membership and record authorization before delivery.
- [ ] **ARCH-011 | P0** Isolate provider/platform administration from practice administration; tenant admins cannot grant themselves platform or another tenant's privileges.
- [ ] **ARCH-012 | P0** Test tenant onboarding, suspension, export and offboarding; privileged data migration requires authorization, audit and reconciliation.

### 3.2 Data correctness and cryptography

- [ ] **ARCH-013 | P0** Enforce foreign keys, state transitions, uniqueness and money invariants in the database; test concurrent requests and partial failures.
- [ ] **ARCH-014 | P0** Use optimistic locking or appropriate database locks for conflicting edits, bookings and finance; retries cannot lose updates or double-charge.
- [ ] **ARCH-015 | P0** Encrypt databases, object storage, queues, backups and sensitive field values according to classification; document who can decrypt each category.
- [ ] **ARCH-016 | P0** Use authenticated encryption with unique nonces, versioned keys and tenant/purpose binding; altered ciphertext and wrong contexts fail safely.
- [ ] **ARCH-017 | P0** Manage keys through KMS/secret management; separate environments and key purposes, restrict decrypt permissions and rehearse rotation and restoration.
- [ ] **ARCH-018 | P0** Hash document bytes for integrity; use protected MACs/signatures where authenticity is needed. Hashing alone does not provide confidentiality or prove authorship.
- [ ] **ARCH-019 | P0** Avoid plain hashes of predictable sensitive identifiers; assess keyed lookup indexes, key separation, leakage and access controls if encrypted search is needed.
- [ ] **ARCH-020 | P0** Apply retention and legal holds to live records, attachments, versions, search indexes, derived data and restored backups; prevent unauthorized early deletion.

### 3.3 Audit integrity and privacy

- [ ] **ARCH-021 | P0** Record sensitive views, changes, exports, role changes, recovery, support access and security events with actor, tenant, object ID, outcome and trusted time.
- [ ] **ARCH-022 | P0** Make required audit writes atomic with critical changes or use a durable transactional outbox; failures cannot silently leave unlogged financial/security changes.
- [ ] **ARCH-023 | P0** Restrict audit update/delete privileges and retention changes; test administrator abuse and alert when logs stop arriving or sequences have gaps.
- [ ] **ARCH-024 | P0** Make audit tampering detectable using protected external checkpoints/signatures or independently retained immutable copies; test modifications and deletions explicitly.
- [ ] **ARCH-025 | P0** Exclude passwords, tokens, full documents and unnecessary medical/legal narratives from logs; protect audit access and redact exported evidence.

### 3.4 Regulatory applicability and vendor responsibilities

- [ ] **ARCH-026 | P0** Establish applicable jurisdictions, data types, controller/processor roles and regulatory obligations with accountable privacy/legal owners; document the result.
- [ ] **ARCH-027 | P0** If HIPAA applies, complete risk analysis and required BAAs for relevant providers/subprocessors; verify the actual contracted products, plans and configurations.
- [ ] **ARCH-028 | P0** For applicable UK/EU GDPR processing, establish lawful basis and any additional condition for special-category data; align notices and processing records.
- [ ] **ARCH-029 | P0** Complete a DPIA before processing likely to present high risk; document international-transfer safeguards and subprocessor/data-location decisions where applicable.
- [ ] **ARCH-030 | P0** Implement identity-verified access, correction, export, restriction and deletion requests; respect legal holds and third-party confidentiality obligations.
- [ ] **ARCH-031 | P0** Approve retention schedules by record category and jurisdiction; audit deletions and document backup expiry rather than claiming immediate erasure everywhere.
- [ ] **ARCH-032 | P0** Verify contracts for incident notice, availability, data return/deletion, subprocessors and termination; test retrieving usable data before vendor exit.
- [ ] **ARCH-033 | P0** If handling legal matters, assess privilege, ethical walls, client-money rules and AML/sanctions obligations separately from healthcare requirements.
- [ ] **ARCH-034 | P0** If deploying clinical workflows, assign clinical safety and professional-practice review; software security testing cannot establish clinical suitability.
- [ ] **ARCH-035 | P1** Maintain a vendor assurance register with evidence expiry and reassessment dates; do not equate encryption or a vendor badge with compliance.

RLS details: [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). Applicability references: [HHS cloud/BAA guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html) and [ICO special-category data/DPIA guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/special-category-data/what-are-the-rules-on-special-category-data/). Requirements need jurisdiction-specific review; this checklist is not a compliance determination.

## 4. Backend API & Microservices Security

### 4.1 Contracts and server boundaries

- [ ] **API-001 | P0** Version and inventory public/private REST, GraphQL, RPC, WebSocket and server-action interfaces; remove obsolete routes, debug endpoints and sample credentials.
- [ ] **API-002 | P0** Enforce strict request and response schemas, including nested fields; negative tests reject type confusion, unknown privileges and oversized collections.
- [ ] **API-003 | P0** Centralize authentication, authorization and tenant context without relying on UI checks; service-to-service calls cannot impersonate arbitrary users.
- [ ] **API-004 | P0** Validate all methods and alternate content types; method overrides, duplicate parameters and URL normalization cannot bypass guards.
- [ ] **API-005 | P0** Restrict CORS to approved exact origins, methods and headers; credentialed requests never allow wildcard origins or reflected attacker origins.
- [ ] **API-006 | P0** For GraphQL, restrict public introspection in production and remove unnecessary explorers; resolver authorization remains enforced independently of discoverability.
- [ ] **API-007 | P0** Bound GraphQL depth, cost, aliases, batching and subscriptions; validate input types and prevent nested cross-tenant relationship traversal.
- [ ] **API-008 | P0** Use output allowlists and safe pagination; error shapes, counts and relationship metadata do not reveal inaccessible records.
- [ ] **API-009 | P0** Implement scoped idempotency for bookings, invoices, payments and imports; duplicate keys with different payloads are rejected predictably.
- [ ] **API-010 | P0** Make critical operations transactional; test deadlocks, dependency failures and retries with no partial finance, booking or audit changes.
- [ ] **API-011 | P0** Disable sensitive shared caching; test CDN, browser and server caches for authenticated-page, API-response and cross-user leakage.
- [ ] **API-012 | P0** Secure real-time channels with origin checks, scoped authorization, message limits and revocation; validate every message and subscription.

### 4.2 Jobs, workers and internal services

- [ ] **API-013 | P0** Authenticate/encrypt queue connections; keep brokers private and restrict producers, consumers and administrative permissions by purpose.
- [ ] **API-014 | P0** Validate versioned job schemas; avoid credentials and unnecessary PII in messages, retry logs and dead-letter queues.
- [ ] **API-015 | P0** Reauthorize queued actions at execution, including current tenant, recipient, membership and record state; revoked permissions cancel work safely.
- [ ] **API-016 | P0** Make workers idempotent; test duplicate delivery, reordered jobs, crashes between processing and acknowledgment, and maximum retry exhaustion.
- [ ] **API-017 | P0** Set worker concurrency, memory/CPU, job duration and tenant quotas; isolate untrusted document processing from billing and authentication workers.
- [ ] **API-018 | P0** Use least-privilege service identities and network policies; verify a compromised worker cannot access unrelated data or management endpoints.
- [ ] **API-019 | P1** Implement monitored dead-letter/replay workflows with authorization, redaction, expiry and operator approval for sensitive replays.
- [ ] **API-020 | P0** Authenticate internal requests with scoped short-lived credentials or mTLS where appropriate; private network placement alone does not authorize callers.

### 4.3 Webhooks and third-party APIs

- [ ] **API-021 | P0** Verify webhook signatures over the exact raw body using official SDKs or constant-time verification; reject before business processing.
- [ ] **API-022 | P0** Validate webhook timestamps, event identity and intended account/environment; deduplicate and prevent replay within documented tolerances.
- [ ] **API-023 | P0** Test forged, repeated, delayed, reordered and partially processed webhook events; external payment status changes never trust browser redirects.
- [ ] **API-024 | P0** Validate third-party response schemas and financial identifiers; set TLS verification, timeouts, response-size caps and bounded retry policies.
- [ ] **API-025 | P0** Scope and rotate integration credentials per environment/tenant where supported; disconnecting an integration revokes tokens and scheduled jobs.
- [ ] **API-026 | P0** Protect outbound webhooks against SSRF; encrypt stored signing secrets, sign payloads and prevent PII leakage to unauthorized subscribers.
- [ ] **API-027 | P1** Exercise vendor outage, quota exhaustion and degraded mode; reconcile missed events and expose actionable status without pretending operations succeeded.

API threat coverage follows the [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/); exact signature/callback semantics must also follow each selected provider's official integration documentation.

## 5. Frontend UX/UI Security & Hardening

### 5.1 Browser and rendering controls

- [ ] **WEB-001 | P0** Enforce a tested CSP with per-response nonces or approved hashes; restrict script sources and remove production unsafe-eval/broad unsafe-inline exceptions.
- [ ] **WEB-002 | P0** Set CSP base-uri, object-src and frame-ancestors deliberately; restrict connect-src, form-action, font, media and image sources to required destinations.
- [ ] **WEB-003 | P0** Block clickjacking with frame-ancestors and suitable X-Frame-Options for supported browsers; test legitimate embedded workflows explicitly.
- [ ] **WEB-004 | P0** Send nosniff, an appropriate Referrer-Policy and narrow Permissions-Policy; enable camera/microphone only for approved telehealth routes/origins.
- [ ] **WEB-005 | P0** Use escaped framework rendering; audit dangerouslySetInnerHTML, innerHTML and third-party rich-text components; sanitize approved HTML using maintained allowlists.
- [ ] **WEB-006 | P0** Allowlist URL schemes for links, images and redirects; reject javascript/data payloads where inappropriate and unsafe embedded SVG/HTML previews.
- [ ] **WEB-007 | P0** Authorize server-rendered pages, server actions and route handlers independently; server-component payloads must not serialize secrets or unauthorized fields.
- [ ] **WEB-008 | P0** Keep server credentials out of bundles, public environment variables, hydration data and source maps; review browser network responses as an attacker would.
- [ ] **WEB-009 | P0** Protect downloads using current permissions, safe Content-Disposition names and appropriate content types; isolate active documents from the authenticated application origin.
- [ ] **WEB-010 | P0** Validate postMessage sender origin, source and message schema; use explicit target origins and do not pass tokens through untrusted frames.

### 5.2 Client storage and privacy

- [ ] **WEB-011 | P0** Inventory localStorage, sessionStorage, IndexedDB, browser caches and service workers; store no unnecessary client/medical/legal data or persistent bearer credentials.
- [ ] **WEB-012 | P0** Scope harmless preferences/drafts by account and tenant; clear sensitive state on logout, session expiry, user switch and tenant switch.
- [ ] **WEB-013 | P0** Prevent PII in URLs, browser titles, analytics, session replay, crash reports and third-party widgets; disable recording of sensitive forms.
- [ ] **WEB-014 | P0** Test browser Back, tab restore, offline mode and cached downloads after logout; use Cache-Control:no-store for sensitive responses where appropriate.
- [ ] **WEB-015 | P0** Self-host or integrity-pin approved assets where feasible; review analytics, chat, tag-manager and video SDK permissions and data transmission.

### 5.3 Usability, accessibility and error recovery

- [ ] **WEB-016 | P0** Provide clear labels, inline errors and preserved safe input after failure; client validation complements rather than replaces server validation.
- [ ] **WEB-017 | P0** Prevent ambiguous destructive actions; explain affected records and approvals, and provide safe cancellation or recovery where supported.
- [ ] **WEB-018 | P0** Handle duplicate submits, retries and stale edits without duplicate bookings/charges or silent overwrites; show confirmed server outcomes.
- [ ] **WEB-019 | P0** Test loading, empty, forbidden, expired-session, offline and partial-failure states; never present unavailable metrics as zero or success.
- [ ] **WEB-020 | P0** Meet the chosen WCAG 2.2 AA target with automated and manual keyboard/screen-reader checks; verify forms, dialogs, tables and notifications.
- [ ] **WEB-021 | P0** Verify contrast, zoom/reflow, visible unobscured focus and touch target sizes; colour and icon shape alone cannot convey critical states.
- [ ] **WEB-022 | P0** Respect reduced motion; avoid distracting loops and flashing, and ensure transitions cannot conceal data or interrupt keyboard access.
- [ ] **WEB-023 | P0** Test supported desktop/mobile browsers, date/currency localization and timezone presentation; show meaningful timezones on appointments and audit displays.
- [ ] **WEB-024 | P1** Provide plain-language instructions and contextual help for each feature, including invitations, MFA loss, billing corrections and secure document sharing.
- [ ] **WEB-025 | P0** Verify client-portal and staff interfaces expose only permitted workflows; hiding navigation never substitutes for server authorization.

References: [CSP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) and [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## 6. Security QA, Penetration Testing & Vulnerability Scanning

### 6.1 Test strategy and evidence

- [ ] **QA-001 | P0** Trace every product requirement and threat to acceptance tests; include positive, negative, boundary, abuse, concurrency and recovery cases.
- [ ] **QA-002 | P0** Create synthetic fixtures for tenant A/B, unrelated clients, assigned/unassigned staff, finance, admins, support and disabled/deleted accounts.
- [ ] **QA-003 | P0** Test each actor against own, peer, restricted and other-tenant records for every operation; include field-level access and indirect identifiers.
- [ ] **QA-004 | P0** Exercise unit, database integration, API contract and end-to-end tests against the deployed production build and realistic infrastructure versions.
- [ ] **QA-005 | P0** Run database integration tests with the actual restricted runtime role; tests using only a database owner cannot establish RLS or privilege safety.
- [ ] **QA-006 | P0** Verify fresh installs, upgrades, schema drift and interrupted migrations; preserve record counts, references, balances and audit continuity.
- [ ] **QA-007 | P0** Test parallel requests, retries, connection loss and process restarts at critical state transitions; verify invariants after each failure.
- [ ] **QA-008 | P0** Test production-sized datasets and agreed p95/p99 latency, error-rate and resource budgets; include noisy-neighbour and large-document scenarios.
- [ ] **QA-009 | P0** Isolate staging/test credentials and data; prevent test workers from contacting real clients, charging cards or using production document buckets.
- [ ] **QA-010 | P1** Evaluate test effectiveness through targeted mutation/fault injection and review of security assertions; coverage percentages alone are insufficient.

### 6.2 Client records and matter/case workflows

- [ ] **CLI-001 | P0** Verify create, view, edit, archive and restore workflows, required fields, Unicode names, duplicates and boundary-length inputs.
- [ ] **CLI-002 | P0** Verify individuals, organizations, related contacts, guardians/delegates and matters link correctly; forbid unauthorized relationship changes and merges.
- [ ] **CLI-003 | P0** Test contact preference, consent and identity-verification changes with history, permissions and required expiry/review dates.
- [ ] **CLI-004 | P0** Restrict confidential notes and sensitive fields by role and relationship; portal responses never include internal-only records or history.
- [ ] **CLI-005 | P0** Test bulk import validation, duplicate detection, failure reports and rollback; malicious spreadsheet formulas remain inert in exports.
- [ ] **CLI-006 | P0** Test global search, filters, autocomplete, counts and pagination; snippets and totals cannot expose inaccessible clients or matters.
- [ ] **CLI-007 | P0** Test simultaneous edits and record merges; preserve references, ownership, audit history and externally linked identifiers without silent data loss.
- [ ] **CLI-008 | P0** Verify deletion, retention and legal holds propagate correctly; require controlled handling of linked invoices, documents and outstanding obligations.
- [ ] **CLI-009 | P0** If providing legal-practice compliance, test conflict screening, CDD/AML holds, sanctions-list freshness and reviewer decisions; restrict sensitive investigative records.

### 6.3 Scheduling and resource management

- [ ] **SCH-001 | P0** Verify appointment creation, viewing, rescheduling and cancellation with authorized practitioner, client, resource, duration and appointment state.
- [ ] **SCH-002 | P0** Prove concurrent requests cannot double-book exclusive staff, rooms or equipment; test buffers, capacity rules and allowed overrides.
- [ ] **SCH-003 | P0** Test UTC storage plus intended timezone rules, daylight-saving gaps/overlaps, midnight, leap days, locale and month/year boundaries.
- [ ] **SCH-004 | P0** Test recurring events and single-occurrence versus series changes; prevent unintended deletion or duplicate reminders across exceptions.
- [ ] **SCH-005 | P0** Verify availability, holidays, leave, booking cutoffs, cancellation windows and no-show handling against approved business rules.
- [ ] **SCH-006 | P0** Scope public booking/reschedule links to one allowed action with expiry; protect slots and client existence against enumeration and reservation abuse.
- [ ] **SCH-007 | P0** Verify reminders use current appointment state, permissions and recipient details; cancellation or reassignment suppresses stale messages.
- [ ] **SCH-008 | P0** Test external calendar sync, provider token revocation, duplicate/out-of-order updates and reconciliation; prevent private details leaking into shared calendars.
- [ ] **SCH-009 | P0** Validate calendar import/export sizes and text escaping, including CRLF/ICS injection; imported URLs cannot trigger unauthorized server fetches.

### 6.4 Billing, payments and financial integrity

- [ ] **BIL-001 | P0** Verify time entries, expenses, rates, discounts, tax and currencies against approved examples; use exact decimal/minor-unit arithmetic and explicit rounding.
- [ ] **BIL-002 | P0** Recalculate totals and payment amounts server-side; changing browser fields, currency or item IDs cannot alter authorized pricing or ownership.
- [ ] **BIL-003 | P0** Verify draft, approval, issuance, void and credit transitions; issued documents retain immutable numbering, line details and auditable corrections.
- [ ] **BIL-004 | P0** Test partial payments, allocations, overpayments, credits, refunds, chargebacks, fees and failed/pending transactions; totals reconcile to authoritative records.
- [ ] **BIL-005 | P0** Test duplicate submissions and concurrent payment/credit events; one financial event creates exactly one intended ledger effect.
- [ ] **BIL-006 | P0** For accounting/client-money features, verify balanced postings, account segregation, reserved funds and reconciliation; prohibit unauthorized negative available balances.
- [ ] **BIL-007 | P0** Require appropriate approval and recent authentication for refunds, bank changes and high-value transfers; test approver separation and altered recipients.
- [ ] **BIL-008 | P0** Use approved hosted/tokenized payment components; keep raw card details out of application storage/logs and never retain card verification codes after authorization.
- [ ] **BIL-009 | P0** Determine PCI DSS scope with the payment provider/acquirer; outsourcing payment capture does not automatically remove all merchant responsibilities.
- [ ] **BIL-010 | P0** Treat signed provider events or verified server queries as payment authority; receipt pages and client-supplied success flags cannot mark bills paid.
- [ ] **BIL-011 | P0** Test sandbox/production separation, reconciliation, webhook secret rotation and recovery after provider outage; never run live-charge tests against real clients.
- [ ] **BIL-012 | P0** Verify invoice PDFs, statements, ageing and dashboards reflect actual allocations, tax and permissions; distinguish issued totals from unpaid/overdue balances.

Payment-data reference: [PCI SSC guidance on card verification codes](https://www.pcisecuritystandards.org/faqs/1280/).

### 6.5 Telehealth, if included in the release

- [ ] **TEL-001 | P0** Approve the video provider, data flows, subprocessors and required contracts; verify the exact features/configuration covered by any BAA or privacy agreement.
- [ ] **TEL-002 | P0** Bind short-lived join credentials to appointment, tenant, participant and role; room IDs or forwarded URLs alone cannot grant admission.
- [ ] **TEL-003 | P0** Test waiting-room admission, provider/host controls, capacity, reconnects and rejection of unknown or revoked participants.
- [ ] **TEL-004 | P0** Prove users cannot enumerate, join, listen to or subscribe to another appointment's signaling/media streams or screen sharing.
- [ ] **TEL-005 | P0** Verify signaling encryption and media DTLS-SRTP; document whether the provider/SFU can decrypt media rather than claiming end-to-end encryption without evidence.
- [ ] **TEL-006 | P0** Restrict TURN credentials by lifetime and quota; test relay abuse, exposed media ports, bandwidth exhaustion and provider egress costs.
- [ ] **TEL-007 | P0** Request camera/microphone permissions only when needed; verify mute, device changes, disconnect and end-call stop tracks and sharing reliably.
- [ ] **TEL-008 | P0** Disable recording/transcription by default; if offered, require applicable consent, visible status, access control, encryption and retention/deletion policies.
- [ ] **TEL-009 | P0** Test connection failure, low bandwidth, accessibility/captions and a clearly communicated fallback; avoid clinical details in meeting titles and notifications.
- [ ] **TEL-010 | P0** Where providing care, validate identity, consent, practitioner authorization and emergency/escalation procedures with clinical/legal owners for applicable locations.

Telehealth applicability: [HHS HIPAA rules for telehealth technology](https://telehealth.hhs.gov/providers/telehealth-policy/hipaa-for-telehealth-technology).

### 6.6 Document management and sharing

- [ ] **DOC-001 | P0** Verify upload, scan, preview, download, version, rename, archive and restore workflows; no file is accessible before all required release checks.
- [ ] **DOC-002 | P0** Recheck authorization for originals, thumbnails, OCR, previous versions, attachments and export bundles; deleting a link does not leave alternate paths open.
- [ ] **DOC-003 | P0** Test version conflicts and file replacement races; hashes, scan results, metadata and downloads reference the same immutable object version.
- [ ] **DOC-004 | P0** Make share links purpose-scoped, unpredictable, expiring and revocable; document any signed-URL access window that remains after revocation.
- [ ] **DOC-005 | P0** Test malware-test files, disguised types, malformed PDFs/images, oversized archives and scanner outages without using live malware or sensitive documents.
- [ ] **DOC-006 | P0** Ensure active documents cannot execute in the application origin; previews cannot make privileged requests or leak session data.
- [ ] **DOC-007 | P0** Encrypt stored objects and processing temporaries; clean abandoned multipart uploads, rejected files, worker scratch space and preview caches.
- [ ] **DOC-008 | P0** Test export authorization, bundle integrity, retention, legal holds and deletion of derived content; backups follow the approved expiry/restoration policy.
- [ ] **DOC-009 | P0** If offering e-signatures, verify signer authentication, consent, document digest/version, timestamps and evidence export against applicable legal requirements.

### 6.7 Communications, reporting and administration

- [ ] **MSG-001 | P0** Test invitation, recovery, appointment and billing notifications end to end; verify recipient isolation, retry deduplication, bounce and unsubscribe/preference handling.
- [ ] **MSG-002 | P0** Keep sensitive content out of email/SMS/push unless an approved secure workflow requires it; links open authenticated records with current permissions.
- [ ] **MSG-003 | P0** Test message templates against HTML/header injection and unsafe links; outgoing messages cannot reveal another tenant's branding, recipient or attachments.
- [ ] **RPT-001 | P0** Verify report totals, filters, currencies, dates and timezone rules against independently calculated fixtures; aggregates obey tenant and field-level permissions.
- [ ] **RPT-002 | P0** Authorize asynchronous report generation and download separately; purge expired exports and prevent predictable export IDs or CSV-formula execution.
- [ ] **RPT-003 | P0** Test staff invitation, role changes, deactivation and team reassignment; document impact on sessions, queues, records, approvals and ownership.
- [ ] **RPT-004 | P0** Audit changes to practice settings, integrations, security policy and retention; validate settings cannot bypass mandatory controls or break tenant isolation.

### 6.8 Automated security pipeline

- [ ] **SEC-001 | P0** Run SAST on pull requests and mainline for application and infrastructure code; triage findings and prevent newly introduced exploitable high-risk issues.
- [ ] **SEC-002 | P0** Run dependency/SCA scanning, such as Dependabot or Snyk, on manifests, lockfiles and deployed images; assess transitive and runtime reachability.
- [ ] **SEC-003 | P0** Scan working trees, full Git history, CI logs and release artifacts for secrets; revoke/rotate discoveries rather than merely deleting the string.
- [ ] **SEC-004 | P0** Scan IaC, container images and configuration; detect public storage, excessive IAM, privileged containers and exposed management interfaces.
- [ ] **SEC-005 | P0** Run authenticated DAST against staging as each relevant role; exclude destructive live flows and verify crawler coverage against the API/route inventory.
- [ ] **SEC-006 | P0** Fuzz schemas, encodings, sizes, pagination and state transitions with bounded workloads; verify stable errors and no crashes, unauthorized changes or resource leaks.
- [ ] **SEC-007 | P0** Produce an SBOM for each release and preserve scan results, exceptions, artifact digest and provenance; prevent scanning one artifact and deploying another.
- [ ] **SEC-008 | P1** Define remediation SLAs by exploitability, exposure and impact; continuously monitor supported runtimes, newly disclosed vulnerabilities and patch availability.

### 6.9 Manual penetration test and red-team validation plan

- [ ] **SEC-009 | P0** Approve written test scope, targets, test accounts, permitted techniques, time windows and stop conditions; obtain provider authorization where needed.
- [ ] **SEC-010 | P0** Map the deployed external surface from an unauthenticated perspective; reconcile exposed hosts, routes, API versions, admin panels and cloud services.
- [ ] **SEC-011 | P0** Test authentication, MFA enrollment/recovery, fixation, reset poisoning, replay and session revocation using controlled accounts and redacted evidence.
- [ ] **SEC-012 | P0** Attempt horizontal, vertical and cross-tenant privilege escalation through identifiers, nested objects, field changes, bulk endpoints and alternate transports.
- [ ] **SEC-013 | P0** Test injection, SSRF, file processing, CSRF, cache boundaries and API business-logic abuse; validate both prevention and security-event visibility.
- [ ] **SEC-014 | P0** Exercise race conditions and workflow bypasses in booking, payment, refunds, approvals and document release; verify database invariants afterward.
- [ ] **SEC-015 | P1** Simulate a compromised low-privilege employee or worker credential; measure containment of data access, lateral movement and exfiltration paths.
- [ ] **SEC-016 | P1** Run an agreed detection exercise for suspicious login, export spikes and privilege abuse; compare event time, alert time and responder action.
- [ ] **SEC-017 | P0** Record reproducible findings with affected roles, impact, severity and owner; fix root causes, add meaningful regressions and independently retest fixes.
- [ ] **SEC-018 | P0** Obtain an independent prelaunch penetration assessment for the sensitive production scope; reconcile findings with the release gate rather than relying on scanner counts.

Manual test reference: [OWASP Web Security Testing Guide](https://owasp.org/projects/web-security-testing-guide). Use synthetic records and non-destructive proofs; real-client extraction is unnecessary to demonstrate an access-control flaw.

## 7. DevOps, Infrastructure & Incident Response

### 7.1 Infrastructure and network controls

- [ ] **OPS-001 | P0** Provision environments with reviewed IaC and repeatable configuration; detect drift and prevent manual changes from bypassing production controls.
- [ ] **OPS-002 | P0** Separate production, staging and development accounts/projects, identities, networks, databases, storage and secrets; prove test credentials cannot access production.
- [ ] **OPS-003 | P0** Keep databases, queues, scanners and management endpoints private; document only necessary public entry points and deny other ingress.
- [ ] **OPS-004 | P0** Restrict east-west and outbound access by service identity/purpose; test that a compromised public service cannot freely reach internal systems.
- [ ] **OPS-005 | P0** Prefer TLS 1.3; retain hardened TLS 1.2 only for documented compatibility needs, or enforce 1.3-only after validating all clients and vendors.
- [ ] **OPS-006 | P0** Disable obsolete TLS and weak ciphers; verify hostnames/certificate chains on browser, service, database, storage and mail connections with no skip-verification exceptions.
- [ ] **OPS-007 | P0** Redirect HTTP to HTTPS and apply staged HSTS; enable includeSubDomains/preload only after validating all affected services and recovery implications.
- [ ] **OPS-008 | P0** Automate certificate issuance/renewal and expiry alerts; verify origin encryption, trusted proxy handling and forwarded-client-IP correctness.
- [ ] **OPS-009 | P0** Protect operator access with MFA, least privilege, short-lived credentials and audited elevation; prohibit shared root accounts and internet-exposed admin ports.
- [ ] **OPS-010 | P0** Use Vault, cloud secret management or a managed equivalent; prevent secrets in Git, images, public variables, command arguments and diagnostic dumps.
- [ ] **OPS-011 | P0** Test rotation of database, storage, SMTP, webhook, session-signing and encryption secrets; retain controlled access to keys needed for existing data/backups.
- [ ] **OPS-012 | P0** Validate managed-platform limits and responsibilities for uploads, persistent workers, scanning, storage, networking and compliance contracts before choosing hosting plans.

TLS baseline: [OWASP TLS guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html). TLS 1.3-only is an architecture decision, not a universal substitute for all other transport safeguards.

### 7.2 Build, supply chain and deployment

- [ ] **OPS-013 | P0** Protect branches and release workflows with review, scoped permissions and MFA; untrusted pull requests cannot access deployment secrets or privileged runners.
- [ ] **OPS-014 | P0** Pin dependencies and build actions to reviewed versions/digests; use lockfiles, trusted registries and controlled package-install scripts.
- [ ] **OPS-015 | P0** Use supported, patched runtimes and minimal images; run non-root with restricted capabilities, read-only filesystem where possible and bounded resources.
- [ ] **OPS-016 | P0** If using Kubernetes, enforce workload identity, RBAC, admission policies, NetworkPolicy and hardened pods; protect the control plane and secrets.
- [ ] **OPS-017 | P0** Produce immutable, traceable release artifacts; verify signatures/digests, SBOM and provenance before promoting the tested artifact into production.
- [ ] **OPS-018 | P0** Validate production startup fails on missing keys, unsafe defaults, debug mode, insecure cookies or demo credentials; secrets never appear in health responses.
- [ ] **OPS-019 | P0** Test readiness/liveness and graceful shutdown; drain requests/jobs and keep critical dependencies from triggering restart storms or partial financial work.
- [ ] **OPS-020 | P0** Run migrations with a dedicated bounded-lifetime identity; rehearse lock duration, old/new application compatibility and partial-deployment failure.
- [ ] **OPS-021 | P0** Use canary/rolling/blue-green deployment where justified; gate promotion on security-relevant smoke tests and objective error/latency thresholds.
- [ ] **OPS-022 | P0** Rehearse application rollback and database roll-forward/recovery; a code rollback must not assume destructive migrations or financial events can be undone safely.
- [ ] **OPS-023 | P0** Review production email DNS and delivery: SPF, DKIM, DMARC, sender alignment, bounce handling and monitored transactional mail queues.
- [ ] **OPS-024 | P0** Remove public test mailboxes, demo users, seed data and staging callbacks; run postdeploy sign-in, recovery, authorization and upload checks with controlled accounts.

### 7.3 Monitoring, alerting and backup integrity

- [ ] **OPS-025 | P0** Centralize structured logs, metrics and traces with redaction, tenant-safe correlation IDs, access controls and documented retention.
- [ ] **OPS-026 | P0** Alert on brute force, MFA resets, role changes, tenant-boundary denials, bulk exports, scanner failures and unexpected outbound connections.
- [ ] **OPS-027 | P0** Alert on payment discrepancies, job backlog, storage/DB capacity, certificate expiry, backup failure and missing/stale audit ingestion.
- [ ] **OPS-028 | P0** Define SLOs, alert thresholds, escalation owners and on-call coverage; send test alerts and verify acknowledgment during and outside working hours.
- [ ] **OPS-029 | P0** Define business-approved recovery point/time objectives; back up databases, objects, configuration and required key material with consistent recovery boundaries.
- [ ] **OPS-030 | P0** Keep encrypted, access-separated, immutable/offline backup copies; prove compromised runtime credentials cannot delete every recoverable copy.
- [ ] **OPS-031 | P0** Restore into a clean isolated environment; verify decryption, record counts, foreign keys, document hashes, ledger balances and application workflows.
- [ ] **OPS-032 | P0** Measure full recovery time/data loss against RTO/RPO; test missing object versions, revoked keys and tenant-specific recovery where promised.
- [ ] **OPS-033 | P0** Document retention and deletion reapplication after restoration; backup recovery must not silently resurrect legally deleted or revoked-access data.
- [ ] **OPS-034 | P1** Schedule restore drills and ransomware/region/provider outage exercises; track corrective actions rather than accepting backup-job success as recovery evidence.

Logging reference: [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

### 7.4 Incident response and operational readiness

- [ ] **OPS-035 | P0** Maintain response playbooks for account takeover, tenant leak, ransomware, stolen keys, malicious upload, payment fraud and provider compromise.
- [ ] **OPS-036 | P0** Name incident commander, technical responders, privacy/legal decision owners and vendor contacts; keep an accessible out-of-band communication path.
- [ ] **OPS-037 | P0** Rehearse containment: revoke sessions/tokens, disable compromised identities, isolate workers, stop sharing/exports and rotate affected credentials without destroying evidence.
- [ ] **OPS-038 | P0** Preserve scoped evidence with trusted timestamps, access controls and chain of custody; avoid collecting unnecessary client data during investigation.
- [ ] **OPS-039 | P0** Establish jurisdiction/contract-specific breach assessment and notification procedures with legal owners; prepare communication templates and decision logs.
- [ ] **OPS-040 | P0** Run a tabletop exercise and a technical recovery exercise; document detection, containment, restoration and notification decision times.
- [ ] **OPS-041 | P1** Publish a security contact and vulnerability-reporting process; assign triage, coordinated disclosure and remediation responsibilities.
- [ ] **OPS-042 | P0** Prepare operational runbooks, support training, account recovery procedures, data export/exit steps and escalation paths; verify another operator can follow them.

Incident-response reference: [NIST SP 800-61 Revision 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final).

### 7.5 Final production release gates

- [ ] **REL-001 | P0** Reconcile product scope against implemented features; unfinished telehealth, billing or authorization controls are disabled and absent from production promises.
- [ ] **REL-002 | P0** Close all applicable P0 tasks; P1 exceptions identify owner, residual risk, compensating control, expiry and follow-up issue.
- [ ] **REL-003 | P0** Resolve exploitable critical/high findings and all demonstrated tenant escapes, account takeover or financial-integrity failures; independently retest their fixes.
- [ ] **REL-004 | P0** Archive passing functional, authorization, migration, accessibility, performance, security and restore evidence for the exact release artifact/configuration.
- [ ] **REL-005 | P0** Verify production contracts, privacy notices, subprocessors, retention, payment configuration and applicable clinical/legal approvals cover actual release scope.
- [ ] **REL-006 | P0** Confirm real SMTP delivery, private storage, current malware signatures, secure public routing, monitoring and incident contacts in the target production account.
- [ ] **REL-007 | P0** Obtain accountable engineering, QA, security, operations and privacy/product sign-off; record release owner, rollback trigger and support/on-call readiness.
- [ ] **REL-008 | P0** Perform controlled postdeployment smoke tests and monitor the launch window; repeat affected checks after security-relevant code, configuration or vendor changes.

## Task issue template

```text
Control ID:
Section / module:
Owner / reviewer:
Priority: P0 or P1
Applicability: Applies / N/A with approved reason
Requirement / threat:
Acceptance criteria:
Test environment / tenant and role fixtures:
Evidence links (redacted):
Commit / artifact digest / configuration version:
Tested at:
Result: Not started / In progress / Failed / Passed / Approved exception
Exception owner / compensating controls / expiry:
```

Checking boxes is not a permanent security guarantee. Reassess applicability and rerun affected controls when the system, dependencies, threats or legal obligations change.
