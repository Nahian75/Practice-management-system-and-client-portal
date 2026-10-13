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
