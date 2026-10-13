-- Client onboarding addendum 17c: Manual identity/company reviews, electronic check records, and company snapshots.

CREATE TABLE app.onboarding_evidence_reviews (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  request_id      uuid        NOT NULL REFERENCES app.onboarding_evidence_requests(id) ON DELETE CASCADE,
  evidence_id     uuid        NOT NULL REFERENCES app.aml_cdd_evidence(id) ON DELETE CASCADE,
  outcome         text        NOT NULL,
  reason          text        NOT NULL,
  exception_note  text,
  reviewed_by     uuid        NOT NULL REFERENCES app.accounts(id),
  reviewed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT onboarding_evidence_review_once UNIQUE (request_id, evidence_id),
  CONSTRAINT onboarding_evidence_review_outcome CHECK (outcome IN ('accepted', 'rejected')),
  CONSTRAINT onboarding_evidence_review_reason CHECK (app.is_safe_document_text(reason) AND length(reason) BETWEEN 5 AND 2000),
  CONSTRAINT onboarding_evidence_review_exception CHECK (exception_note IS NULL OR (app.is_safe_document_text(exception_note) AND length(exception_note) BETWEEN 5 AND 2000))
);
CREATE INDEX onboarding_evidence_reviews_req_idx ON app.onboarding_evidence_reviews(request_id, reviewed_at DESC, id DESC);
CREATE INDEX onboarding_evidence_reviews_ev_idx ON app.onboarding_evidence_reviews(evidence_id, reviewed_at DESC, id DESC);

CREATE TABLE app.onboarding_electronic_checks (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id           uuid        NOT NULL REFERENCES app.clients(id) ON DELETE CASCADE,
  cdd_case_id         uuid        REFERENCES app.aml_cdd_cases(id) ON DELETE CASCADE,
  provider            text        NOT NULL,
  service             text        NOT NULL,
  provider_reference  text        NOT NULL,
  document_type       text        NOT NULL,
  check_date          date        NOT NULL,
  result              text        NOT NULL,
  liveness_result     text,
  evidence_match      text,
  exception_note      text,
  raw_response_hash   bytea       NOT NULL,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT onboarding_electronic_check_provider CHECK (app.is_safe_text(provider) AND length(provider) BETWEEN 1 AND 100),
  CONSTRAINT onboarding_electronic_check_service CHECK (app.is_safe_text(service) AND length(service) BETWEEN 1 AND 100),
  CONSTRAINT onboarding_electronic_check_ref CHECK (app.is_safe_text(provider_reference) AND length(provider_reference) BETWEEN 1 AND 150),
  CONSTRAINT onboarding_electronic_check_doc_type CHECK (app.is_safe_text(document_type) AND length(document_type) BETWEEN 1 AND 100),
  CONSTRAINT onboarding_electronic_check_date CHECK (check_date >= DATE '1900-01-01'),
  CONSTRAINT onboarding_electronic_check_result CHECK (result IN ('pass', 'refer', 'fail')),
  CONSTRAINT onboarding_electronic_check_liveness CHECK (liveness_result IS NULL OR liveness_result IN ('pass', 'refer', 'fail', 'not_checked')),
  CONSTRAINT onboarding_electronic_check_match CHECK (evidence_match IS NULL OR (app.is_safe_document_text(evidence_match) AND length(evidence_match) <= 1000)),
  CONSTRAINT onboarding_electronic_check_exception CHECK (exception_note IS NULL OR (app.is_safe_document_text(exception_note) AND length(exception_note) <= 2000)),
  CONSTRAINT onboarding_electronic_check_hash CHECK (octet_length(raw_response_hash) = 32)
);
CREATE INDEX onboarding_electronic_checks_client_idx ON app.onboarding_electronic_checks(client_id, recorded_at DESC, id DESC);
CREATE INDEX onboarding_electronic_checks_case_idx ON app.onboarding_electronic_checks(cdd_case_id, recorded_at DESC, id DESC);

CREATE TABLE app.onboarding_company_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id           uuid        NOT NULL REFERENCES app.clients(id) ON DELETE CASCADE,
  cdd_case_id         uuid        REFERENCES app.aml_cdd_cases(id) ON DELETE CASCADE,
  source              text        NOT NULL,
  company_number      text        NOT NULL,
  company_name        text        NOT NULL,
  company_status      text        NOT NULL,
  company_type        text,
  jurisdiction        text,
  incorporation_date  date,
  registered_office   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  officers            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  discrepancies       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  raw_payload_hash    bytea       NOT NULL,
  retrieved_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  CONSTRAINT onboarding_company_snapshot_source CHECK (source IN ('companies_house', 'overseas_registry', 'manual_evidence')),
  CONSTRAINT onboarding_company_snapshot_number CHECK (app.is_safe_text(company_number) AND length(company_number) BETWEEN 1 AND 50),
  CONSTRAINT onboarding_company_snapshot_name CHECK (app.is_safe_text(company_name) AND length(company_name) BETWEEN 1 AND 250),
  CONSTRAINT onboarding_company_snapshot_status CHECK (app.is_safe_text(company_status) AND length(company_status) BETWEEN 1 AND 50),
  CONSTRAINT onboarding_company_snapshot_inc_date CHECK (incorporation_date IS NULL OR incorporation_date >= DATE '1800-01-01'),
  CONSTRAINT onboarding_company_snapshot_hash CHECK (octet_length(raw_payload_hash) = 32)
);
CREATE INDEX onboarding_company_snapshots_client_idx ON app.onboarding_company_snapshots(client_id, retrieved_at DESC, id DESC);
CREATE INDEX onboarding_company_snapshots_case_idx ON app.onboarding_company_snapshots(cdd_case_id, retrieved_at DESC, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.onboarding_evidence_reviews,
  app.onboarding_electronic_checks,
  app.onboarding_company_snapshots FROM pms_app;

CREATE TRIGGER onboarding_evidence_reviews_fixed BEFORE UPDATE OR DELETE ON app.onboarding_evidence_reviews
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER onboarding_electronic_checks_fixed BEFORE UPDATE OR DELETE ON app.onboarding_electronic_checks
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER onboarding_company_snapshots_fixed BEFORE UPDATE OR DELETE ON app.onboarding_company_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();

CREATE TRIGGER onboarding_evidence_reviews_no_truncate BEFORE TRUNCATE ON app.onboarding_evidence_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER onboarding_electronic_checks_no_truncate BEFORE TRUNCATE ON app.onboarding_electronic_checks
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER onboarding_company_snapshots_no_truncate BEFORE TRUNCATE ON app.onboarding_company_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();

CREATE FUNCTION app.review_onboarding_evidence(
  target_request uuid,
  target_evidence uuid,
  selected_outcome text,
  selected_reason text,
  selected_exception text,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE req app.onboarding_evidence_requests%ROWTYPE;
DECLARE created_id uuid;
BEGIN
  SELECT * INTO req FROM app.onboarding_evidence_requests WHERE id=target_request FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_aml_client_access(actor_id, req.client_id);

  PERFORM 1 FROM app.onboarding_evidence_submissions
    WHERE request_id=target_request AND evidence_id=target_evidence FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence submission not found for this request' USING ERRCODE='check_violation';
  END IF;

  IF EXISTS(SELECT 1 FROM app.onboarding_evidence_reviews WHERE request_id=target_request AND evidence_id=target_evidence) THEN
    RAISE EXCEPTION 'this submission has already been reviewed' USING ERRCODE='check_violation';
  END IF;

  IF selected_outcome NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'invalid review outcome' USING ERRCODE='check_violation';
  END IF;

  INSERT INTO app.onboarding_evidence_reviews(request_id, evidence_id, outcome, reason, exception_note, reviewed_by)
  VALUES (target_request, target_evidence, selected_outcome, selected_reason, selected_exception, actor_id)
  RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.review_onboarding_evidence(uuid,uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.review_onboarding_evidence(uuid,uuid,text,text,text,uuid) TO pms_app;

CREATE FUNCTION app.record_onboarding_electronic_check(
  target_client uuid,
  target_case uuid,
  selected_provider text,
  selected_service text,
  selected_reference text,
  selected_doc_type text,
  selected_date date,
  selected_result text,
  selected_liveness text,
  selected_match text,
  selected_exception text,
  selected_hash bytea,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_aml_client_access(actor_id, target_client);
  IF target_case IS NOT NULL THEN
    PERFORM 1 FROM app.aml_cdd_cases WHERE id=target_case AND client_id=target_client FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CDD case does not belong to this client' USING ERRCODE='check_violation'; END IF;
  END IF;
  IF selected_date > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'check date cannot be in the future' USING ERRCODE='check_violation';
  END IF;

  INSERT INTO app.onboarding_electronic_checks(
    client_id, cdd_case_id, provider, service, provider_reference, document_type,
    check_date, result, liveness_result, evidence_match, exception_note, raw_response_hash, recorded_by
  ) VALUES (
    target_client, target_case, selected_provider, selected_service, selected_reference, selected_doc_type,
    selected_date, selected_result, selected_liveness, selected_match, selected_exception, selected_hash, actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_onboarding_electronic_check(uuid,uuid,text,text,text,text,date,text,text,text,text,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_onboarding_electronic_check(uuid,uuid,text,text,text,text,date,text,text,text,text,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_onboarding_company_snapshot(
  target_client uuid,
  target_case uuid,
  selected_source text,
  selected_number text,
  selected_name text,
  selected_status text,
  selected_type text,
  selected_jurisdiction text,
  selected_inc_date date,
  selected_office jsonb,
  selected_officers jsonb,
  selected_discrepancies jsonb,
  selected_hash bytea,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_aml_client_access(actor_id, target_client);
  IF target_case IS NOT NULL THEN
    PERFORM 1 FROM app.aml_cdd_cases WHERE id=target_case AND client_id=target_client FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CDD case does not belong to this client' USING ERRCODE='check_violation'; END IF;
  END IF;

  INSERT INTO app.onboarding_company_snapshots(
    client_id, cdd_case_id, source, company_number, company_name, company_status,
    company_type, jurisdiction, incorporation_date, registered_office, officers,
    discrepancies, raw_payload_hash, recorded_by
  ) VALUES (
    target_client, target_case, selected_source, selected_number, selected_name, selected_status,
    selected_type, selected_jurisdiction, selected_inc_date, selected_office, selected_officers,
    selected_discrepancies, selected_hash, actor_id
  ) RETURNING id INTO created_id;

  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_onboarding_company_snapshot(uuid,uuid,text,text,text,text,text,text,date,jsonb,jsonb,jsonb,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_onboarding_company_snapshot(uuid,uuid,text,text,text,text,text,text,date,jsonb,jsonb,jsonb,bytea,uuid) TO pms_app;
