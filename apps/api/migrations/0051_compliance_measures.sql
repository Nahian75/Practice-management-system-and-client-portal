-- Compliance / AML step 15c-2: discrete CDD/EDD measures with recorded results,
-- and source-of-funds / source-of-wealth conclusions. Everything is append-only;
-- a later result or conclusion supersedes an earlier one.

CREATE FUNCTION app.is_enhanced_aml_measure(kind text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT kind IN ('additional_sources', 'ownership_background', 'transaction_reasons',
    'source_of_funds', 'source_of_wealth', 'enhanced_monitoring')
$$;
REVOKE ALL ON FUNCTION app.is_enhanced_aml_measure(text) FROM PUBLIC;

CREATE TABLE app.aml_measures (
  id                  uuid        PRIMARY KEY,
  assessment_id       uuid        NOT NULL REFERENCES app.aml_risk_assessments(id),
  kind                text        NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_measures_kind_valid CHECK (kind IN ('identity', 'beneficial_ownership', 'authority',
    'purpose_nature', 'ongoing_monitoring', 'additional_sources', 'ownership_background',
    'transaction_reasons', 'source_of_funds', 'source_of_wealth', 'enhanced_monitoring', 'other')),
  CONSTRAINT aml_measures_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_measures_context_valid CHECK (encryption_context = 'aml-measure:' || id::text)
);
CREATE INDEX aml_measures_assessment_idx ON app.aml_measures (assessment_id, id);

CREATE TABLE app.aml_measure_results (
  id                  uuid        PRIMARY KEY,
  measure_id          uuid        NOT NULL REFERENCES app.aml_measures(id),
  outcome             text        NOT NULL,
  evidence_ids        uuid[]      NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_measure_results_outcome_valid CHECK (outcome IN ('satisfied', 'not_satisfied')),
  CONSTRAINT aml_measure_results_evidence_valid CHECK (cardinality(evidence_ids) <= 50 AND array_position(evidence_ids, NULL) IS NULL),
  CONSTRAINT aml_measure_results_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_measure_results_context_valid CHECK (encryption_context = 'aml-measure-result:' || id::text)
);
CREATE INDEX aml_measure_results_measure_idx ON app.aml_measure_results (measure_id, id DESC);

CREATE TABLE app.aml_source_conclusions (
  id                  uuid        PRIMARY KEY,
  assessment_id       uuid        NOT NULL REFERENCES app.aml_risk_assessments(id),
  kind                text        NOT NULL,
  subject_id          uuid        REFERENCES app.aml_cdd_subjects(id),
  amount_min_pence    bigint      NOT NULL,
  amount_max_pence    bigint      NOT NULL,
  outcome             text        NOT NULL,
  evidence_ids        uuid[]      NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_source_conclusions_kind_valid CHECK (kind IN ('funds', 'wealth')),
  CONSTRAINT aml_source_conclusions_amount_valid CHECK (amount_min_pence >= 0 AND amount_max_pence >= amount_min_pence
    AND amount_max_pence <= 100000000000000),
  CONSTRAINT aml_source_conclusions_outcome_valid CHECK (outcome IN ('satisfied', 'not_satisfied')),
  CONSTRAINT aml_source_conclusions_evidence_valid CHECK (cardinality(evidence_ids) <= 50 AND array_position(evidence_ids, NULL) IS NULL),
  CONSTRAINT aml_source_conclusions_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_source_conclusions_context_valid CHECK (encryption_context = 'aml-source:' || id::text)
);
CREATE INDEX aml_source_conclusions_assessment_idx ON app.aml_source_conclusions (assessment_id, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_measures, app.aml_measure_results,
  app.aml_source_conclusions FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_measures', 'aml_measure_results', 'aml_source_conclusions'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- Locks and returns the assessment after checking matter access, that the matter
-- is not closed and that this is still the matter's latest assessment version.
CREATE FUNCTION app.assert_current_aml_assessment(target_assessment uuid, actor_id uuid)
  RETURNS app.aml_risk_assessments
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.aml_risk_assessments%ROWTYPE;
BEGIN
  SELECT * INTO target FROM app.aml_risk_assessments WHERE id = target_assessment FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_aml_matter_access(actor_id, target.matter_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_risk:' || target.matter_id::text, 0));
  IF EXISTS (SELECT 1 FROM app.matters WHERE id = target.matter_id AND status = 'closed') THEN
    RAISE EXCEPTION 'a closed matter cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_risk_assessments WHERE matter_id = target.matter_id AND version > target.version) THEN
    RAISE EXCEPTION 'only the latest assessment version can be worked on' USING ERRCODE = 'check_violation';
  END IF;
  RETURN target;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_current_aml_assessment(uuid, uuid) FROM PUBLIC;

-- Evidence must come from the CDD case the assessment relies on.
CREATE FUNCTION app.assert_aml_case_evidence(assessment app.aml_risk_assessments, selected uuid[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF cardinality(selected) > 0 AND (assessment.cdd_case_id IS NULL OR EXISTS (
    SELECT 1 FROM unnest(selected) evidence_id
    WHERE NOT EXISTS (SELECT 1 FROM app.aml_cdd_evidence e WHERE e.id = evidence_id AND e.cdd_case_id = assessment.cdd_case_id)
  )) THEN
    RAISE EXCEPTION 'evidence must belong to the relied-on CDD case' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_aml_case_evidence(app.aml_risk_assessments, uuid[]) FROM PUBLIC;

CREATE FUNCTION app.add_aml_measure(target_id uuid, target_assessment uuid, selected_kind text,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_current_aml_assessment(target_assessment, actor_id);
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_measures(id, assessment_id, kind, encryption_context, key_version, nonce, ciphertext, auth_tag, recorded_by)
    VALUES (target_id, target_assessment, selected_kind, selected_context, selected_key, selected_nonce,
      selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.add_aml_measure(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_measure(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.record_aml_measure_result(target_id uuid, target_measure uuid, selected_outcome text,
  selected_evidence uuid[], selected_context text, selected_key smallint, selected_nonce bytea,
  selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE measure app.aml_measures%ROWTYPE;
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
BEGIN
  SELECT * INTO measure FROM app.aml_measures WHERE id = target_measure FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  assessment := app.assert_current_aml_assessment(measure.assessment_id, actor_id);
  PERFORM app.assert_aml_case_evidence(assessment, selected_evidence);
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_measure_results(id, measure_id, outcome, evidence_ids, encryption_context, key_version,
    nonce, ciphertext, auth_tag, recorded_by)
    VALUES (target_id, target_measure, selected_outcome, selected_evidence, selected_context, selected_key,
      selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_measure_result(uuid, uuid, text, uuid[], text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_measure_result(uuid, uuid, text, uuid[], text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.record_aml_source_conclusion(target_id uuid, target_assessment uuid, selected_kind text,
  selected_subject uuid, selected_min bigint, selected_max bigint, selected_outcome text, selected_evidence uuid[],
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
BEGIN
  assessment := app.assert_current_aml_assessment(target_assessment, actor_id);
  IF selected_subject IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.aml_cdd_subjects
    WHERE id = selected_subject AND cdd_case_id = assessment.cdd_case_id) THEN
    RAISE EXCEPTION 'the person must belong to the relied-on CDD case' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_subject IS NULL AND assessment.cdd_case_id IS NOT NULL THEN
    RAISE EXCEPTION 'name the relevant person from the CDD case' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.assert_aml_case_evidence(assessment, selected_evidence);
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_source_conclusions(id, assessment_id, kind, subject_id, amount_min_pence, amount_max_pence,
    outcome, evidence_ids, encryption_context, key_version, nonce, ciphertext, auth_tag, recorded_by)
    VALUES (target_id, target_assessment, selected_kind, selected_subject, selected_min, selected_max,
      selected_outcome, selected_evidence, selected_context, selected_key, selected_nonce, selected_ciphertext,
      selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_source_conclusion(uuid, uuid, text, uuid, bigint, bigint, text, uuid[], text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_source_conclusion(uuid, uuid, text, uuid, bigint, bigint, text, uuid[], text, smallint, bytea, bytea, bytea, uuid) TO pms_app;
