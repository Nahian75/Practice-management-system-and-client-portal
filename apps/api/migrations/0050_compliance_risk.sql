-- Compliance / AML step 15c-1: partner-approved high-risk-country list versions
-- and permanent matter risk-assessment versions.

-- A sorted, duplicate-free list of upper-case ISO 3166 alpha-2 codes. Sorting
-- makes two lists with the same countries byte-identical.
CREATE FUNCTION app.is_sorted_country_codes(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT value IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(value) code WHERE code IS NULL OR code !~ '^[A-Z]{2}$')
    AND value = ARRAY(SELECT DISTINCT code COLLATE "C" FROM unnest(value) code ORDER BY 1)
$$;
REVOKE ALL ON FUNCTION app.is_sorted_country_codes(text[]) FROM PUBLIC;

CREATE TABLE app.aml_country_list_versions (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  version         integer     NOT NULL UNIQUE,
  countries       text[]      NOT NULL,
  source          text        NOT NULL,
  effective_from  date        NOT NULL,
  prepared_by     uuid        NOT NULL REFERENCES app.accounts(id),
  prepared_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_country_list_versions_version_positive CHECK (version > 0),
  CONSTRAINT aml_country_list_versions_countries_valid CHECK (
    app.is_sorted_country_codes(countries) AND cardinality(countries) BETWEEN 1 AND 250
  ),
  CONSTRAINT aml_country_list_versions_source_safe CHECK (app.is_safe_text(source) AND length(source) BETWEEN 1 AND 2000),
  CONSTRAINT aml_country_list_versions_date_valid CHECK (effective_from >= DATE '1900-01-01')
);

CREATE TABLE app.aml_country_list_approvals (
  id                       uuid        PRIMARY KEY DEFAULT uuidv7(),
  country_list_version_id  uuid        NOT NULL UNIQUE REFERENCES app.aml_country_list_versions(id),
  approved_by              uuid        NOT NULL REFERENCES app.accounts(id),
  approved_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.aml_risk_assessments (
  id                       uuid        PRIMARY KEY,
  matter_id                uuid        NOT NULL REFERENCES app.matters(id),
  client_id                uuid        NOT NULL REFERENCES app.clients(id),
  version                  integer     NOT NULL,
  in_scope                 boolean     NOT NULL,
  cdd_case_id              uuid        REFERENCES app.aml_cdd_cases(id),
  country_list_version_id  uuid        NOT NULL REFERENCES app.aml_country_list_versions(id),
  rating                   text        NOT NULL,
  pep                      boolean     NOT NULL,
  high_risk_country        boolean     NOT NULL,
  unusual_transactions     boolean     NOT NULL,
  complex_structure        boolean     NOT NULL,
  cash                     boolean     NOT NULL,
  remote_instruction       boolean     NOT NULL,
  adverse_information      boolean     NOT NULL,
  sanctions_exposure       boolean     NOT NULL,
  third_party_funding      boolean     NOT NULL,
  jurisdictions            text[]      NOT NULL,
  expected_value           text        NOT NULL,
  lowers_previous          boolean     NOT NULL,
  review_due_on            date        NOT NULL,
  review_grace_days        smallint    NOT NULL,
  encryption_context       text        NOT NULL UNIQUE,
  key_version              smallint    NOT NULL,
  nonce                    bytea       NOT NULL,
  ciphertext               bytea       NOT NULL,
  auth_tag                 bytea       NOT NULL,
  prepared_by              uuid        NOT NULL REFERENCES app.accounts(id),
  submitted_at             timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_risk_assessments_version_positive CHECK (version > 0),
  CONSTRAINT aml_risk_assessments_matter_version_unique UNIQUE (matter_id, version),
  CONSTRAINT aml_risk_assessments_rating_valid CHECK (rating IN ('low', 'standard', 'high')),
  -- Regulation 33 requires enhanced due diligence for these; no score may lower them.
  CONSTRAINT aml_risk_assessments_mandatory_high CHECK (
    NOT (pep OR high_risk_country OR unusual_transactions) OR rating = 'high'
  ),
  CONSTRAINT aml_risk_assessments_scope_needs_cdd CHECK (NOT in_scope OR cdd_case_id IS NOT NULL),
  CONSTRAINT aml_risk_assessments_jurisdictions_valid CHECK (
    app.is_sorted_country_codes(jurisdictions) AND cardinality(jurisdictions) BETWEEN 1 AND 50
  ),
  CONSTRAINT aml_risk_assessments_value_valid CHECK (
    expected_value IN ('none', 'under_10k', '10k_to_100k', '100k_to_1m', 'over_1m')
  ),
  CONSTRAINT aml_risk_assessments_grace_valid CHECK (review_grace_days BETWEEN 0 AND 90),
  CONSTRAINT aml_risk_assessments_crypto_valid CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 200000
  ),
  CONSTRAINT aml_risk_assessments_context_valid CHECK (encryption_context = 'aml-risk:' || id::text)
);
CREATE INDEX aml_risk_assessments_matter_recent ON app.aml_risk_assessments (matter_id, version DESC);

CREATE TABLE app.aml_risk_assessment_controls (
  assessment_id       uuid NOT NULL REFERENCES app.aml_risk_assessments(id),
  control_version_id  uuid NOT NULL REFERENCES app.aml_control_versions(id),
  kind                text NOT NULL,
  PRIMARY KEY (assessment_id, kind),
  UNIQUE (assessment_id, control_version_id)
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.aml_country_list_versions, app.aml_country_list_approvals,
  app.aml_risk_assessments, app.aml_risk_assessment_controls FROM pms_app;

-- Owner-level inserts are refused too, except inside the protected functions below.
CREATE FUNCTION app.protect_aml_risk_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_risk_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'risk records are written only through protected functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_aml_risk_insert() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_country_list_versions', 'aml_country_list_approvals',
    'aml_risk_assessments', 'aml_risk_assessment_controls'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.london_today() RETURNS date
  LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'Europe/London')::date
$$;
REVOKE ALL ON FUNCTION app.london_today() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.london_today() TO pms_app;

-- The latest approved firm control of a kind that is in force on the day.
CREATE FUNCTION app.current_aml_control(selected_kind text, on_day date) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.id FROM app.aml_control_versions v
  JOIN app.aml_control_approvals p ON p.control_version_id = v.id
  WHERE v.kind = selected_kind AND v.effective_from <= on_day AND v.review_due_on >= on_day
  ORDER BY v.version DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.current_aml_control(text, date) FROM PUBLIC;

-- The latest approved high-risk-country list in force on the day.
CREATE FUNCTION app.current_aml_country_list(on_day date) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT v.id FROM app.aml_country_list_versions v
  JOIN app.aml_country_list_approvals p ON p.country_list_version_id = v.id
  WHERE v.effective_from <= on_day
  ORDER BY v.version DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.current_aml_country_list(date) FROM PUBLIC;

-- Compliance sees every matter; a Partner or fee earner only a matter whose team
-- they are actively on. Raises P0002 for an unknown matter and 42501 otherwise.
CREATE FUNCTION app.assert_aml_matter_access(actor_id uuid, target_matter uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.matters WHERE id = target_matter FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.accounts WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML matter access required' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM 1 FROM app.account_roles WHERE account_id = actor_id AND role = 'compliance' AND revoked_at IS NULL FOR SHARE;
  IF FOUND THEN RETURN; END IF;
  PERFORM 1 FROM app.account_roles WHERE account_id = actor_id AND role IN ('partner', 'fee_earner')
    AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML matter access required' USING ERRCODE = 'insufficient_privilege'; END IF;
  PERFORM 1 FROM app.matter_team WHERE matter_id = target_matter AND account_id = actor_id AND removed_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML matter access required' USING ERRCODE = 'insufficient_privilege'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_aml_matter_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_aml_matter_access(uuid, uuid) TO pms_app;

CREATE FUNCTION app.create_aml_country_list(
  selected_countries text[], selected_source text, selected_effective_from date, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
DECLARE next_version integer;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_country_list', 0));
  SELECT coalesce(max(version), 0) + 1 INTO next_version FROM app.aml_country_list_versions;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_country_list_versions(version, countries, source, effective_from, prepared_by)
    VALUES (next_version, selected_countries, selected_source, selected_effective_from, actor_id)
    RETURNING id INTO created_id;
  PERFORM set_config('app.aml_risk_write', '0', true);
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_aml_country_list(text[], text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_country_list(text[], text, date, uuid) TO pms_app;

CREATE FUNCTION app.approve_aml_country_list(target_id uuid, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.aml_country_list_versions%ROWTYPE;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'partner');
  SELECT * INTO target FROM app.aml_country_list_versions WHERE id = target_id FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF target.prepared_by = actor_id THEN
    RAISE EXCEPTION 'the preparer cannot approve this country list' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_country_list_approvals(country_list_version_id, approved_by) VALUES (target_id, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.approve_aml_country_list(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_aml_country_list(uuid, uuid) TO pms_app;

CREATE FUNCTION app.aml_rating_rank(rating text) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE rating WHEN 'low' THEN 1 WHEN 'standard' THEN 2 WHEN 'high' THEN 3 END
$$;
REVOKE ALL ON FUNCTION app.aml_rating_rank(text) FROM PUBLIC;

-- Fixes one permanent assessment version. PostgreSQL, not the caller, decides the
-- version, the high-risk-country hit, the CDD case relied on, whether the rating
-- was lowered and which firm controls and country list governed it.
CREATE FUNCTION app.submit_aml_risk_assessment(
  target_id uuid, target_matter uuid, selected_in_scope boolean, selected_rating text,
  selected_pep boolean, selected_unusual boolean, selected_complex boolean, selected_cash boolean,
  selected_remote boolean, selected_adverse boolean, selected_sanctions boolean, selected_third_party boolean,
  selected_jurisdictions text[], selected_value text, selected_review_due date, selected_grace smallint,
  lowering_grounds_given boolean,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.matters%ROWTYPE;
DECLARE today date := app.london_today();
DECLARE list_id uuid;
DECLARE list_countries text[];
DECLARE relied_case uuid;
DECLARE previous_rating text;
DECLARE next_version integer;
DECLARE lowers boolean;
DECLARE control_kind text;
DECLARE control_id uuid;
BEGIN
  PERFORM app.assert_aml_matter_access(actor_id, target_matter);
  SELECT * INTO target FROM app.matters WHERE id = target_matter FOR SHARE;
  IF target.status = 'closed' THEN
    RAISE EXCEPTION 'a closed matter cannot be assessed' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_risk:' || target_matter::text, 0));

  IF selected_review_due <= today OR selected_review_due > today + 1826 THEN
    RAISE EXCEPTION 'the review date must be within five years' USING ERRCODE = 'check_violation';
  END IF;

  list_id := app.current_aml_country_list(today);
  IF list_id IS NULL THEN
    RAISE EXCEPTION 'an approved high-risk-country list is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT countries INTO list_countries FROM app.aml_country_list_versions WHERE id = list_id;

  SELECT id INTO relied_case FROM app.aml_cdd_cases
    WHERE client_id = target.client_id AND status = 'submitted'
    ORDER BY version DESC LIMIT 1 FOR SHARE;

  SELECT rating INTO previous_rating FROM app.aml_risk_assessments
    WHERE matter_id = target_matter ORDER BY version DESC LIMIT 1;
  SELECT coalesce(max(version), 0) + 1 INTO next_version FROM app.aml_risk_assessments WHERE matter_id = target_matter;
  lowers := previous_rating IS NOT NULL AND app.aml_rating_rank(selected_rating) < app.aml_rating_rank(previous_rating);
  IF lowers AND NOT lowering_grounds_given THEN
    RAISE EXCEPTION 'lowering a rating needs explicit grounds' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_risk_assessments(
    id, matter_id, client_id, version, in_scope, cdd_case_id, country_list_version_id, rating,
    pep, high_risk_country, unusual_transactions, complex_structure, cash, remote_instruction,
    adverse_information, sanctions_exposure, third_party_funding, jurisdictions, expected_value,
    lowers_previous, review_due_on, review_grace_days,
    encryption_context, key_version, nonce, ciphertext, auth_tag, prepared_by)
  VALUES (
    target_id, target_matter, target.client_id, next_version, selected_in_scope, relied_case, list_id, selected_rating,
    selected_pep, selected_jurisdictions && list_countries, selected_unusual, selected_complex, selected_cash, selected_remote,
    selected_adverse, selected_sanctions, selected_third_party, selected_jurisdictions, selected_value,
    lowers, selected_review_due, selected_grace,
    selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);

  FOREACH control_kind IN ARRAY ARRAY['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
    'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy'] LOOP
    control_id := app.current_aml_control(control_kind, today);
    IF control_id IS NULL THEN
      RAISE EXCEPTION 'current approved firm controls are required' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO app.aml_risk_assessment_controls(assessment_id, control_version_id, kind)
      VALUES (target_id, control_id, control_kind);
  END LOOP;
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.submit_aml_risk_assessment(uuid, uuid, boolean, text, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, text[], text, date, smallint, boolean, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_aml_risk_assessment(uuid, uuid, boolean, text, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, text[], text, date, smallint, boolean, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;
