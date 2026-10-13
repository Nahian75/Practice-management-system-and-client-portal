-- 0074_ai_foundations.sql
-- Step 18a: Foundation, governance, and provider-neutral boundary for AI module.
-- Introduces:
-- 1. app.ai_configurations: Firm-wide model settings, active provider, and monthly token budget.
-- 2. app.ai_requests: Append-only audit log of model invocations (actor, matter, tokens, latency, prompt hash).
-- 3. app.ai_drafts: Generated unapproved draft outputs with structured citations.
-- 4. app.ai_reviews: Append-only human-in-the-loop review actions (accepted, modified, rejected).
-- 5. Security definer functions enforcing matter team ethical walls and token budget controls.

CREATE TABLE app.ai_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'offline_mock'
    CONSTRAINT ai_provider_valid CHECK (provider IN ('offline_mock', 'azure_openai', 'aws_bedrock', 'custom')),
  model_name text NOT NULL DEFAULT 'mock-legal-assistant'
    CONSTRAINT ai_model_name_not_empty CHECK (btrim(model_name) <> ''),
  endpoint_url text,
  max_tokens_per_request integer NOT NULL DEFAULT 4096
    CONSTRAINT ai_max_tokens_valid CHECK (max_tokens_per_request > 0 AND max_tokens_per_request <= 32768),
  monthly_token_budget integer NOT NULL DEFAULT 500000
    CONSTRAINT ai_monthly_budget_valid CHECK (monthly_token_budget > 0),
  tokens_used_this_month integer NOT NULL DEFAULT 0
    CONSTRAINT ai_tokens_used_valid CHECK (tokens_used_this_month >= 0),
  budget_reset_on date NOT NULL DEFAULT ((date_trunc('month', clock_timestamp() AT TIME ZONE 'Europe/London') + INTERVAL '1 month')::date),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES app.accounts (id)
);

-- Seed singleton initial configuration row
INSERT INTO app.ai_configurations (
  id, provider, model_name, max_tokens_per_request, monthly_token_budget, tokens_used_this_month, enabled
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid, 'offline_mock', 'mock-legal-assistant', 4096, 500000, 0, true
) ON CONFLICT DO NOTHING;

CREATE TABLE app.ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES app.accounts (id),
  matter_id uuid NOT NULL REFERENCES app.matters (id),
  feature text NOT NULL
    CONSTRAINT ai_feature_valid CHECK (feature IN ('summarise_document', 'draft_correspondence', 'extract_chronology', 'review_clauses')),
  model_name text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0 CONSTRAINT ai_prompt_tokens_valid CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CONSTRAINT ai_completion_tokens_valid CHECK (completion_tokens >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CONSTRAINT ai_latency_valid CHECK (latency_ms >= 0),
  prompt_hash bytea NOT NULL,
  status text NOT NULL
    CONSTRAINT ai_status_valid CHECK (status IN ('succeeded', 'refused', 'error')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ai_requests_matter_idx ON app.ai_requests (matter_id, created_at DESC);
CREATE INDEX ai_requests_actor_idx ON app.ai_requests (actor_id, created_at DESC);

CREATE TABLE app.ai_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.ai_requests (id),
  matter_id uuid NOT NULL REFERENCES app.matters (id),
  draft_type text NOT NULL
    CONSTRAINT ai_draft_type_valid CHECK (draft_type IN ('document_summary', 'correspondence_draft', 'chronology', 'clause_notes')),
  title text NOT NULL CONSTRAINT ai_draft_title_not_empty CHECK (btrim(title) <> ''),
  generated_text text NOT NULL,
  structured_citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ai_drafts_matter_idx ON app.ai_drafts (matter_id, created_at DESC);

CREATE TABLE app.ai_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL UNIQUE REFERENCES app.ai_drafts (id),
  reviewer_id uuid NOT NULL REFERENCES app.accounts (id),
  decision text NOT NULL
    CONSTRAINT ai_review_decision_valid CHECK (decision IN ('accepted', 'modified', 'rejected')),
  final_text text,
  feedback_reason text,
  promoted_to_document_id uuid REFERENCES app.documents (id),
  promoted_to_task_id uuid REFERENCES app.tasks (id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ai_reviews_reviewer_idx ON app.ai_reviews (reviewer_id, reviewed_at DESC);

-- Immutability triggers on requests, drafts, and reviews
CREATE OR REPLACE FUNCTION app.prevent_ai_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI audit records are immutable and cannot be updated or deleted'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER ai_requests_immutable
  BEFORE UPDATE OR DELETE ON app.ai_requests
  FOR EACH ROW EXECUTE FUNCTION app.prevent_ai_mutation();

CREATE TRIGGER ai_drafts_immutable
  BEFORE UPDATE OR DELETE ON app.ai_drafts
  FOR EACH ROW EXECUTE FUNCTION app.prevent_ai_mutation();

CREATE TRIGGER ai_reviews_immutable
  BEFORE UPDATE OR DELETE ON app.ai_reviews
  FOR EACH ROW EXECUTE FUNCTION app.prevent_ai_mutation();

-- Privilege grants
REVOKE ALL ON app.ai_configurations FROM PUBLIC;
REVOKE ALL ON app.ai_requests FROM PUBLIC;
REVOKE ALL ON app.ai_drafts FROM PUBLIC;
REVOKE ALL ON app.ai_reviews FROM PUBLIC;

GRANT SELECT ON app.ai_configurations TO pms_app;
GRANT SELECT, INSERT ON app.ai_requests TO pms_app;
GRANT SELECT, INSERT ON app.ai_drafts TO pms_app;
GRANT SELECT, INSERT ON app.ai_reviews TO pms_app;

-- Access assertion for matter AI actions
CREATE OR REPLACE FUNCTION app.assert_matter_ai_access(actor_id uuid, target_matter uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts
    WHERE id = actor_id AND kind = 'staff' AND status = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM app.account_roles
    WHERE account_id = actor_id AND role IN ('partner', 'fee_earner') AND revoked_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner or fee_earner role required for AI drafting assistance'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM app.matters WHERE id = target_matter FOR SHARE;
  IF NOT FOUND THEN
    RAISE NO_DATA_FOUND;
  END IF;

  -- Ethical wall enforcement: actor must be active on the matter team
  PERFORM 1 FROM app.matter_team
    WHERE matter_id = target_matter AND account_id = actor_id AND removed_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'matter team membership required to access matter AI assistance'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_matter_ai_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_matter_ai_access(uuid, uuid) TO pms_app;

-- Record AI Generation function (handles token budgeting and transactional draft creation)
CREATE OR REPLACE FUNCTION app.record_ai_generation(
  actor_id uuid,
  target_matter uuid,
  feature_name text,
  model_name text,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  prompt_hash bytea,
  draft_type text,
  draft_title text,
  generated_text text,
  structured_citations jsonb DEFAULT '[]'::jsonb,
  confidence_notes text DEFAULT NULL
) RETURNS TABLE(request_id uuid, draft_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cfg RECORD;
  today_date date;
  new_req_id uuid;
  new_draft_id uuid;
  total_tokens integer;
BEGIN
  PERFORM app.assert_matter_ai_access(actor_id, target_matter);

  SELECT * INTO cfg FROM app.ai_configurations
    WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI configuration not found' USING ERRCODE = 'data_exception';
  END IF;

  IF NOT cfg.enabled THEN
    RAISE EXCEPTION 'AI drafting assistant is disabled by firm policy'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  today_date := (clock_timestamp() AT TIME ZONE 'Europe/London')::date;
  IF cfg.budget_reset_on <= today_date THEN
    UPDATE app.ai_configurations
      SET tokens_used_this_month = 0,
          budget_reset_on = ((date_trunc('month', clock_timestamp() AT TIME ZONE 'Europe/London') + INTERVAL '1 month')::date)
      WHERE id = cfg.id;
    cfg.tokens_used_this_month := 0;
  END IF;

  total_tokens := prompt_tokens + completion_tokens;
  IF total_tokens > cfg.max_tokens_per_request THEN
    RAISE EXCEPTION 'request tokens (%) exceed configured ceiling (%)', total_tokens, cfg.max_tokens_per_request
      USING ERRCODE = 'check_violation';
  END IF;

  IF cfg.tokens_used_this_month + total_tokens > cfg.monthly_token_budget THEN
    RAISE EXCEPTION 'monthly firm AI token budget exhausted (% of % tokens used)', cfg.tokens_used_this_month, cfg.monthly_token_budget
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE app.ai_configurations
    SET tokens_used_this_month = cfg.tokens_used_this_month + total_tokens
    WHERE id = cfg.id;

  INSERT INTO app.ai_requests (
    actor_id, matter_id, feature, model_name, prompt_tokens, completion_tokens, latency_ms, prompt_hash, status
  ) VALUES (
    actor_id, target_matter, feature_name, model_name, prompt_tokens, completion_tokens, latency_ms, prompt_hash, 'succeeded'
  ) RETURNING id INTO new_req_id;

  INSERT INTO app.ai_drafts (
    request_id, matter_id, draft_type, title, generated_text, structured_citations, confidence_notes
  ) VALUES (
    new_req_id, target_matter, draft_type, draft_title, generated_text, structured_citations, confidence_notes
  ) RETURNING id INTO new_draft_id;

  RETURN QUERY SELECT new_req_id, new_draft_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_ai_generation(uuid, uuid, text, text, integer, integer, integer, bytea, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ai_generation(uuid, uuid, text, text, integer, integer, integer, bytea, text, text, text, jsonb, text) TO pms_app;

-- Record AI Review function (human-in-the-loop audit log)
CREATE OR REPLACE FUNCTION app.record_ai_review(
  actor_id uuid,
  target_draft uuid,
  decision_name text,
  final_content text DEFAULT NULL,
  reason_note text DEFAULT NULL,
  promoted_doc uuid DEFAULT NULL,
  promoted_task uuid DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target_matter uuid;
  new_review_id uuid;
BEGIN
  SELECT matter_id INTO target_matter FROM app.ai_drafts WHERE id = target_draft FOR SHARE;
  IF NOT FOUND THEN
    RAISE NO_DATA_FOUND;
  END IF;

  PERFORM app.assert_matter_ai_access(actor_id, target_matter);

  PERFORM 1 FROM app.ai_reviews WHERE draft_id = target_draft;
  IF FOUND THEN
    RAISE EXCEPTION 'draft has already been reviewed' USING ERRCODE = 'unique_violation';
  END IF;

  IF decision_name NOT IN ('accepted', 'modified', 'rejected') THEN
    RAISE EXCEPTION 'invalid review decision: %', decision_name USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.ai_reviews (
    draft_id, reviewer_id, decision, final_text, feedback_reason, promoted_to_document_id, promoted_to_task_id
  ) VALUES (
    target_draft, actor_id, decision_name, final_content, reason_note, promoted_doc, promoted_task
  ) RETURNING id INTO new_review_id;

  RETURN new_review_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_ai_review(uuid, uuid, text, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_ai_review(uuid, uuid, text, text, text, uuid, uuid) TO pms_app;

-- Configuration management
CREATE OR REPLACE FUNCTION app.update_ai_configuration(
  actor_id uuid,
  new_provider text,
  new_model text,
  new_endpoint text,
  new_max_tokens integer,
  new_monthly_budget integer,
  new_enabled boolean
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts
    WHERE id = actor_id AND kind = 'staff' AND status = 'active'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM 1 FROM app.account_roles
    WHERE account_id = actor_id AND role = 'partner' AND revoked_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner role required to update AI configuration'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE app.ai_configurations
    SET provider = new_provider,
        model_name = new_model,
        endpoint_url = new_endpoint,
        max_tokens_per_request = new_max_tokens,
        monthly_token_budget = new_monthly_budget,
        enabled = new_enabled,
        updated_at = clock_timestamp(),
        updated_by = actor_id
    WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
END;
$$;
REVOKE ALL ON FUNCTION app.update_ai_configuration(uuid, text, text, text, integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_ai_configuration(uuid, text, text, text, integer, integer, boolean) TO pms_app;
