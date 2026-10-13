# AI Security

**Current state (2026-10-14):** First-version design approved ([ai.md](ai.md)).
Steps 18a to 18f establish strict security controls for generative AI and legal
drafting assistance in a UK legal practice.

## Core security principles

1. **Human-in-the-Loop Authority (Non-Autonomous):**
   - AI output is exclusively an unapproved draft.
   - AI never provides legal advice, never makes an automated legal or casework
     decision, never approves AML/SAR reports, and never makes employment decisions.
   - An authorized fee earner or partner must review, verify, and explicitly sign off
     on all generated text before it can be saved as a matter document or sent to a client.

2. **Legal Professional Privilege & Zero Data Retention:**
   - Client matter data must never be transmitted to consumer or public AI models,
     or models that retain prompts for training or product improvement.
   - External provider drivers require enterprise Zero Data Retention (ZDR)
     agreements, customer-managed keys, and hosting within UK/EEA regions
     (e.g., Azure OpenAI UK South, AWS Bedrock London).
   - In local development and automated testing, an offline mock (`OfflineMockAiProvider`)
     or self-hosted local model is used without network egress.

3. **Domain Isolation & Ethical Walls:**
   - **HR Exclusion:** Per [`docs/hr.md`](hr.md), no AI services ever receive or
     process HR/personnel files, health records, sickness absences, or disciplinary casework.
   - **Compliance Exclusion:** Per [`docs/compliance.md`](compliance.md), no AI services
     ever access restricted suspicion reports or generate SAR/DAML conclusions.
   - **Matter Boundary:** Every AI operation verifies active matter team assignment
     or supervising partner authority in PostgreSQL (`app.assert_matter_access`).
     Prompts are strictly scoped to the specified matter; cross-matter data leakage is
     structurally prevented.

4. **Indirect Prompt Injection Defense:**
   - Untrusted counterparty documents, emails, and PDFs are encapsulated within
     strict structural XML delimiters (`<untrusted_document_content>`).
   - System instructions mandate that text within delimiters is treated strictly
     as passive data for analysis, never as instructions to execute.
   - AI outputs must conform to strict JSON schemas; unstructured executable commands
     are rejected at the API validation boundary.

5. **Data Minimisation & Pre-Prompt Redaction:**
   - Automated regex/NLP masking filters strip UK National Insurance numbers,
     payment card details, bank account numbers, dates of birth, and unnecessary
     personal identifiers prior to prompt assembly.

6. **Grounding & Hallucination Mitigation:**
   - Factual extractions and chronologies require structured citations linking
     every assertion to a specific document ID, page, and quoted excerpt.
   - UI prominently flags all AI-generated drafts with statutory verification
     warnings, mandating independent verification of legal authorities against
     official primary sources ([legislation.gov.uk](https://www.legislation.gov.uk/), [BAILII](https://www.bailii.org/)).

7. **Token Budgeting & Denial-of-Wallet Protection:**
   - Hard request token limits (32k context).
   - Per-user daily limits, per-matter limits, and firm-wide monthly token budgets
     enforced with row-level share locks in PostgreSQL.

8. **Append-Only Auditability:**
   - Database tables `app.ai_requests`, `app.ai_drafts`, and `app.ai_reviews` are
     append-only with triggers preventing updates and deletions.
   - Comprehensive audit trail records actor ID, matter ID, feature, model, prompt hash,
     tokens consumed, latency, original draft, and human review decisions.

## Security Review & Threat Verification Report (Step 18)

Conducted on 2026-10-14 covering automated adversarial penetration tests (`apps/api/src/ai/ai-security-review.spec.ts`), architecture boundaries, and regulatory compliance.

### 1. Vector 1: Adversarial Prompt Injection & Delimiter Escaping
- **Threat:** Malicious counterparty documents, emails, or instructions embedding XML breakout tags (`</untrusted_matter_document>`, `<system>`), DAN jailbreaks, or instruction override commands ("IGNORE ALL PREVIOUS INSTRUCTIONS").
- **Verification Result:** PASS (Zero escapes).
  - Delimiter sanitization (`PromptBuilderService.escapeDelimiters`) replaces raw closing tags with XML entities (`&lt;/untrusted_matter_document&gt;`).
  - Hardened system prompt mandates passive data interpretation with non-negotiable SRA directives.
  - Heuristic injection detector intercepts suspicious override phrases and logs `ai.prompt_injection_detected` audit events without executing commands.

### 2. Vector 2: Cross-Matter Ethical Wall & Domain Isolation
- **Threat:** Fee earner supplying document IDs from Matter B while generating drafts on Matter A, or attempting to ingest HR records / AML restricted suspicion reports into the AI pipeline.
- **Verification Result:** PASS (Strict isolation).
  - `AiService.generateDraft` mandates `AiRepository.validateMatterDocumentOwnership`. Referenced documents not belonging to the active matter immediately trigger `ForbiddenException` and abort execution before contacting the provider.
  - PostgreSQL access gate (`app.assert_matter_ai_access` and `app.assert_matter_access`) verifies fee earner active assignment and absence of ethical wall blocks.
  - Hard domain exclusions enforced: `hr.*` and `compliance.restricted_reports` tables have zero AI endpoints, bindings, or foreign keys.

### 3. Vector 3: Sensitive Data Minimisation & UK PII Pre-Prompt Masking
- **Threat:** Prompts containing sensitive client identifiers (UK National Insurance numbers, payment cards, bank sort codes, 8-digit bank accounts, passwords, or dates of birth) sent to AI providers in violation of UK GDPR Article 5(1)(c).
- **Verification Result:** PASS (Zero unmasked sensitive PII).
  - Pre-prompt regex redaction pipeline scrubs NI numbers (including HMRC test prefix QQ), Visa/Mastercard/Amex numbers, sort codes, account numbers, credentials, and DOBs into standardized tokens (`[REDACTED_*]`).
  - Legal citations, UK statutes, case law references, and normal statutory dates are preserved without false positives.

### 4. Vector 4: Denial-of-Wallet & Token Budget Exhaustion Hard Stops
- **Threat:** Oversized requests, batch floods, or runaway API calls generating exorbitant provider costs or exhausting firm quota.
- **Verification Result:** PASS (Hard stops enforced).
  - Pre-flight token estimation: requests exceeding per-request limit (`maxTokensPerRequest: 4096`) are rejected with `BadRequestException` before invoking external APIs.
  - Firm-wide monthly budget (`monthlyTokenBudget: 100,000` tokens) enforces hard stop via `ForbiddenException` when exhausted.
  - Per-matter monthly limit (150,000 tokens) prevents single-case budget capture.
  - Emergency supervisory kill-switch (`enabled: false`) immediately halts all generation requests firm-wide.

### 5. Vector 5: Human-in-the-Loop Authority & Privilege Escalation Defense
- **Threat:** Autonomous execution, AI-driven legal advice, or unauthorized promotion of unvetted or rejected drafts into official matter files.
- **Verification Result:** PASS (Strict human authority).
  - AI outputs are saved in PostgreSQL as `unapproved_draft` with mandatory SRA regulatory warnings.
  - Rejection gate: a `rejected` draft cannot be promoted to `app.documents` or `app.tasks`.
  - Promotion gate: promotion to official matter documents (`app.documents`) and scheduled tasks (`app.tasks`) requires an explicit `accepted` or `modified` human review decision by an authorized fee earner.

### 6. Vector 6: Grounding, Hallucination Mitigation & SRA Compliance
- **Threat:** Hallucinated case citations or fabricated clauses misleading clients or courts (SRA Code of Conduct paras 1.4, 2.1, 3.2).
- **Verification Result:** PASS (Audited citation grounding).
  - `CitationGroundingService` validates quoted excerpts against matter source documents using exact and fuzzy Jaccard word-overlap matching.
  - Unverified citations flag compliance audit warnings (`ai.citation_unverified`), append statutory cautionary notices to the draft, and display highlighted visual warnings in the staff web workbench.

