-- Client onboarding addendum 17e: engagement templates, document generation, signatures and reviews.

-- 1. Engagement Templates Table
CREATE TABLE app.engagement_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  title text NOT NULL,
  version integer NOT NULL,
  body_markdown text NOT NULL,
  allowed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT engagement_templates_key_version_unique UNIQUE (template_key, version),
  CONSTRAINT engagement_templates_key_valid CHECK (
    template_key IN ('letter_of_authority', 'client_care_letter', 'fee_agreement')
  )
);

CREATE INDEX engagement_templates_lookup_idx
  ON app.engagement_templates (template_key, is_active, version DESC);

-- Trigger: protect templates from update or delete (immutable)
CREATE OR REPLACE FUNCTION app.protect_engagement_template_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engagement templates are immutable versions and cannot be updated or deleted'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER engagement_templates_immutable
  BEFORE UPDATE OR DELETE ON app.engagement_templates
  FOR EACH ROW EXECUTE FUNCTION app.protect_engagement_template_immutable();


-- 2. Engagement Documents Table
CREATE TABLE app.engagement_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES app.clients(id),
  matter_id uuid REFERENCES app.matters(id),
  template_id uuid NOT NULL REFERENCES app.engagement_templates(id),
  template_version integer NOT NULL,
  title text NOT NULL,
  document_kind text NOT NULL CHECK (
    document_kind IN ('letter_of_authority', 'client_care_letter', 'fee_agreement')
  ),
  state text NOT NULL DEFAULT 'draft' CHECK (
    state IN ('draft', 'sent', 'viewed', 'signed', 'declined', 'expired', 'verified')
  ),
  input_snapshot jsonb NOT NULL,
  rendered_content text NOT NULL,
  content_hash text NOT NULL,
  generated_by uuid NOT NULL REFERENCES app.accounts(id),
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  viewed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  expires_at timestamptz
);

CREATE INDEX engagement_documents_client_idx
  ON app.engagement_documents (client_id, generated_at DESC);
CREATE INDEX engagement_documents_matter_idx
  ON app.engagement_documents (matter_id, generated_at DESC);
CREATE INDEX engagement_documents_state_idx
  ON app.engagement_documents (state);

-- Trigger: protect engagement documents from deletion and arbitrary updates
CREATE OR REPLACE FUNCTION app.protect_engagement_document_changes() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engagement documents cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.id <> OLD.id OR
     NEW.client_id <> OLD.client_id OR
     NEW.matter_id IS DISTINCT FROM OLD.matter_id OR
     NEW.template_id <> OLD.template_id OR
     NEW.template_version <> OLD.template_version OR
     NEW.document_kind <> OLD.document_kind OR
     NEW.input_snapshot <> OLD.input_snapshot OR
     NEW.rendered_content <> OLD.rendered_content OR
     NEW.content_hash <> OLD.content_hash OR
     NEW.generated_by <> OLD.generated_by OR
     NEW.generated_at <> OLD.generated_at THEN
    RAISE EXCEPTION 'immutable fields of engagement document cannot be altered'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER engagement_documents_protected
  BEFORE UPDATE OR DELETE ON app.engagement_documents
  FOR EACH ROW EXECUTE FUNCTION app.protect_engagement_document_changes();


-- 3. Engagement Signatures Table
CREATE TABLE app.engagement_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_document_id uuid NOT NULL REFERENCES app.engagement_documents(id),
  signer_name text NOT NULL,
  signer_email text,
  signer_role text NOT NULL CHECK (
    signer_role IN ('client', 'representative', 'director', 'officer')
  ),
  signature_method text NOT NULL CHECK (
    signature_method IN ('wet_signature_upload', 'portal_drawn', 'provider_electronic')
  ),
  document_id uuid REFERENCES app.documents(id),
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX engagement_signatures_doc_idx
  ON app.engagement_signatures (engagement_document_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION app.protect_engagement_signature_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engagement signatures are immutable records' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER engagement_signatures_immutable
  BEFORE UPDATE OR DELETE ON app.engagement_signatures
  FOR EACH ROW EXECUTE FUNCTION app.protect_engagement_signature_immutable();


-- 4. Engagement Signature Reviews Table
CREATE TABLE app.engagement_signature_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_id uuid NOT NULL REFERENCES app.engagement_signatures(id),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  reason text NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES app.accounts(id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX engagement_reviews_sig_idx
  ON app.engagement_signature_reviews (signature_id, reviewed_at DESC);

CREATE OR REPLACE FUNCTION app.protect_engagement_review_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signature reviews are immutable records' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER engagement_reviews_immutable
  BEFORE UPDATE OR DELETE ON app.engagement_signature_reviews
  FOR EACH ROW EXECUTE FUNCTION app.protect_engagement_review_immutable();


-- 5. Seed default approved templates (Version 1)
INSERT INTO app.engagement_templates (
  template_key, title, version, body_markdown, allowed_fields, is_active, created_by
) VALUES
(
  'letter_of_authority',
  'Standard Letter of Authority',
  1,
  '# Letter of Authority

**To Whom It May Concern:**

I/We hereby authorise **{{firm_name}}** to act on my/our behalf in connection with all matters relating to **{{matter_title}}**.

This authority includes, without limitation, the power to:
1. Request, receive, and inspect all documents, records, financial statements, and correspondence held by any third party, financial institution, governmental authority, or counterparty.
2. Communicate with counterparties and their legal representatives on my/our behalf.
3. Take all necessary legal, administrative, and procedural steps reasonably required to represent my/our interests.

**Client Name:** {{client_name}}  
**Date of Authority:** {{effective_date}}  
**Authority Scope:** {{scope_of_authority}}  

This authority remains in full force and effect until revoked in writing by the undersigned.',
  '["client_name", "firm_name", "matter_title", "effective_date", "scope_of_authority"]'::jsonb,
  true,
  NULL
),
(
  'client_care_letter',
  'Standard Client Care Letter',
  1,
  '# Client Care Letter & Terms of Engagement

**Dear {{client_name}},**

Thank you for instructing **{{firm_name}}** to represent you in relation to **{{matter_title}}**. This letter sets out the terms of our engagement, the scope of work we have agreed to undertake, and important statutory information regarding our service.

### 1. Scope of Work
We have agreed to advise and represent you in relation to:
{{scope_of_work}}

### 2. People Responsible for Your Work
The fee earner with primary conduct of your matter is **{{fee_earner_name}}**. Supervision of this matter is overseen by **{{supervising_partner}}**.

### 3. Fee Arrangements
{{fee_arrangement}}

### 4. Client Care and Complaints Procedure
We are committed to providing high quality legal advice and client care. If you have any concerns about our service or an invoice, please contact our Complaints Partner, **{{complaints_partner}}**. We maintain a formal complaints handling procedure which is available on request.

### 5. Regulatory Notice
{{firm_name}} is authorised and regulated by the Solicitors Regulation Authority (SRA).

Please confirm your acceptance of these terms by signing and returning this document.',
  '["client_name", "firm_name", "matter_title", "scope_of_work", "fee_earner_name", "supervising_partner", "fee_arrangement", "complaints_partner"]'::jsonb,
  true,
  NULL
),
(
  'fee_agreement',
  'Standard Fee Agreement & Cost Estimate',
  1,
  '# Legal Fee Agreement & Payment Terms

**Client:** {{client_name}}  
**Matter:** {{matter_title}}  
**Firm:** {{firm_name}}  

### 1. Agreed Charging Basis
{{charging_basis}}

### 2. Hourly Rates or Fixed Fee
- **Fee structure:** {{fee_structure_details}}
- **Estimated disbursements:** {{estimated_disbursements}}
- **Value Added Tax (VAT):** Standard UK rate of 20% applies to legal fees and taxable disbursements where applicable.

### 3. Payment Terms & Invoicing
Invoices will be issued {{billing_frequency}}. Invoices are payable within **{{payment_terms_days}} days** of the date of issue. We reserve the right to cease work on this matter if payments are not made in accordance with these terms.

### 4. Client Monies
Any funds paid on account of costs or disbursements will be held in our designated client bank account in accordance with the SRA Accounts Rules.

Please sign below to confirm your agreement to these charging terms.',
  '["client_name", "matter_title", "firm_name", "charging_basis", "fee_structure_details", "estimated_disbursements", "billing_frequency", "payment_terms_days"]'::jsonb,
  true,
  NULL
);


-- 6. Functions for PMS App

-- Create new engagement template version
CREATE OR REPLACE FUNCTION app.create_engagement_template(
  selected_key text,
  selected_title text,
  selected_body text,
  selected_fields jsonb,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  created_id uuid;
  next_version integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'compliance')
  ) THEN
    RAISE EXCEPTION 'only partner or compliance can create engagement templates'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.engagement_template:' || selected_key, 0));

  SELECT coalesce(max(version), 0) + 1 INTO next_version
  FROM app.engagement_templates
  WHERE template_key = selected_key;

  INSERT INTO app.engagement_templates (
    template_key, title, version, body_markdown, allowed_fields, is_active, created_by
  ) VALUES (
    selected_key, selected_title, next_version, selected_body, selected_fields, true, actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;


-- Generate engagement document
CREATE OR REPLACE FUNCTION app.generate_engagement_document(
  target_client uuid,
  target_matter uuid,
  target_template uuid,
  selected_title text,
  selected_snapshot jsonb,
  selected_rendered text,
  selected_hash text,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  template_row app.engagement_templates%ROWTYPE;
  created_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner')
  ) THEN
    RAISE EXCEPTION 'only fee earner or partner can generate engagement documents'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO template_row FROM app.engagement_templates WHERE id = target_template;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement template not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.engagement_documents (
    client_id, matter_id, template_id, template_version, title,
    document_kind, state, input_snapshot, rendered_content, content_hash,
    generated_by
  ) VALUES (
    target_client, target_matter, target_template, template_row.version, selected_title,
    template_row.template_key, 'draft', selected_snapshot, selected_rendered, selected_hash,
    actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;


-- Send engagement document
CREATE OR REPLACE FUNCTION app.send_engagement_document(
  target_doc uuid,
  target_expires timestamptz,
  actor_id uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc_row app.engagement_documents%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner')
  ) THEN
    RAISE EXCEPTION 'only fee earner or partner can send engagement documents'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO doc_row FROM app.engagement_documents WHERE id = target_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement document not found' USING ERRCODE = 'P0002';
  END IF;

  IF doc_row.state NOT IN ('draft', 'declined') THEN
    RAISE EXCEPTION 'document can only be sent from draft or declined state'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.engagement_documents
  SET state = 'sent',
      sent_at = clock_timestamp(),
      expires_at = target_expires,
      declined_at = NULL,
      decline_reason = NULL
  WHERE id = target_doc;
END;
$$;


-- Mark engagement document viewed (by portal or staff)
CREATE OR REPLACE FUNCTION app.mark_engagement_document_viewed(
  target_doc uuid
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE app.engagement_documents
  SET state = 'viewed',
      viewed_at = clock_timestamp()
  WHERE id = target_doc AND state = 'sent';
END;
$$;


-- Record engagement signature
CREATE OR REPLACE FUNCTION app.record_engagement_signature(
  target_doc uuid,
  selected_signer text,
  selected_email text,
  selected_role text,
  selected_method text,
  selected_doc_id uuid,
  selected_metadata jsonb,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc_row app.engagement_documents%ROWTYPE;
  created_id uuid;
BEGIN
  SELECT * INTO doc_row FROM app.engagement_documents WHERE id = target_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement document not found' USING ERRCODE = 'P0002';
  END IF;

  IF doc_row.state NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'document must be sent or viewed to be signed'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.engagement_signatures (
    engagement_document_id, signer_name, signer_email, signer_role,
    signature_method, document_id, raw_metadata, recorded_by
  ) VALUES (
    target_doc, selected_signer, selected_email, selected_role,
    selected_method, selected_doc_id, selected_metadata, actor_id
  ) RETURNING id INTO created_id;

  UPDATE app.engagement_documents
  SET state = 'signed'
  WHERE id = target_doc;

  RETURN created_id;
END;
$$;


-- Decline engagement document
CREATE OR REPLACE FUNCTION app.decline_engagement_document(
  target_doc uuid,
  selected_reason text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  doc_row app.engagement_documents%ROWTYPE;
BEGIN
  SELECT * INTO doc_row FROM app.engagement_documents WHERE id = target_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement document not found' USING ERRCODE = 'P0002';
  END IF;

  IF doc_row.state NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'document can only be declined from sent or viewed state'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.engagement_documents
  SET state = 'declined',
      declined_at = clock_timestamp(),
      decline_reason = selected_reason
  WHERE id = target_doc;
END;
$$;


-- Review engagement signature
CREATE OR REPLACE FUNCTION app.review_engagement_signature(
  target_sig uuid,
  selected_outcome text,
  selected_reason text,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sig_row app.engagement_signatures%ROWTYPE;
  created_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles ar
    JOIN app.accounts a ON a.id = ar.account_id
    WHERE ar.account_id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'fee_earner', 'compliance')
  ) THEN
    RAISE EXCEPTION 'only fee earner, partner or compliance can review engagement signatures'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO sig_row FROM app.engagement_signatures WHERE id = target_sig;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement signature not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO app.engagement_signature_reviews (
    signature_id, outcome, reason, reviewed_by
  ) VALUES (
    target_sig, selected_outcome, selected_reason, actor_id
  ) RETURNING id INTO created_id;

  IF selected_outcome = 'accepted' THEN
    UPDATE app.engagement_documents
    SET state = 'verified'
    WHERE id = sig_row.engagement_document_id;
  ELSE
    UPDATE app.engagement_documents
    SET state = 'declined',
        declined_at = clock_timestamp(),
        decline_reason = 'Signature rejected: ' || selected_reason
    WHERE id = sig_row.engagement_document_id;
  END IF;

  RETURN created_id;
END;
$$;


-- 7. Permissions and Grants
REVOKE ALL ON app.engagement_templates FROM PUBLIC;
GRANT SELECT ON app.engagement_templates TO pms_app;

REVOKE ALL ON app.engagement_documents FROM PUBLIC;
GRANT SELECT ON app.engagement_documents TO pms_app;

REVOKE ALL ON app.engagement_signatures FROM PUBLIC;
GRANT SELECT ON app.engagement_signatures TO pms_app;

REVOKE ALL ON app.engagement_signature_reviews FROM PUBLIC;
GRANT SELECT ON app.engagement_signature_reviews TO pms_app;

REVOKE ALL ON FUNCTION app.create_engagement_template(text, text, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_engagement_template(text, text, text, jsonb, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.generate_engagement_document(uuid, uuid, uuid, text, jsonb, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.generate_engagement_document(uuid, uuid, uuid, text, jsonb, text, text, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.send_engagement_document(uuid, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.send_engagement_document(uuid, timestamptz, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.mark_engagement_document_viewed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_engagement_document_viewed(uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.record_engagement_signature(uuid, text, text, text, text, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_engagement_signature(uuid, text, text, text, text, uuid, jsonb, uuid) TO pms_app;

REVOKE ALL ON FUNCTION app.decline_engagement_document(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decline_engagement_document(uuid, text) TO pms_app;

REVOKE ALL ON FUNCTION app.review_engagement_signature(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.review_engagement_signature(uuid, text, text, uuid) TO pms_app;
