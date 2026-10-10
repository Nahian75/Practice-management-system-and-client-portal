-- Compliance / AML step 15c-3: Compliance clearance, senior-management approval
-- and the live compliance gate state of a matter.

-- Identity edits to a client make any clearance that relied on earlier details due for review.
CREATE TABLE app.aml_client_changes (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id   uuid        NOT NULL REFERENCES app.clients(id),
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX aml_client_changes_client_idx ON app.aml_client_changes (client_id, changed_at);

CREATE FUNCTION app.record_aml_client_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF to_jsonb(NEW) - 'client_id' IS DISTINCT FROM to_jsonb(OLD) - 'client_id' THEN
    INSERT INTO app.aml_client_changes(client_id) VALUES (NEW.client_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_client_change() FROM PUBLIC;
CREATE TRIGGER client_individuals_aml_change AFTER UPDATE ON app.client_individuals
  FOR EACH ROW EXECUTE FUNCTION app.record_aml_client_change();
CREATE TRIGGER client_organisations_aml_change AFTER UPDATE ON app.client_organisations
  FOR EACH ROW EXECUTE FUNCTION app.record_aml_client_change();

CREATE TABLE app.aml_clearances (
  id                       uuid        PRIMARY KEY,
  matter_id                uuid        NOT NULL REFERENCES app.matters(id),
  assessment_id            uuid        NOT NULL UNIQUE REFERENCES app.aml_risk_assessments(id),
  decision                 text        NOT NULL,
  needs_senior             boolean     NOT NULL,
  relied_measure_results   uuid[]      NOT NULL,
  relied_conclusions       uuid[]      NOT NULL,
  encryption_context       text        NOT NULL UNIQUE,
  key_version              smallint    NOT NULL,
  nonce                    bytea       NOT NULL,
  ciphertext               bytea       NOT NULL,
  auth_tag                 bytea       NOT NULL,
  decided_by               uuid        NOT NULL REFERENCES app.accounts(id),
  decided_at               timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_clearances_decision_valid CHECK (decision IN ('approved', 'refused')),
  CONSTRAINT aml_clearances_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_clearances_context_valid CHECK (encryption_context = 'aml-clearance:' || id::text)
);
CREATE INDEX aml_clearances_matter_idx ON app.aml_clearances (matter_id, decided_at DESC);

CREATE TABLE app.aml_senior_approvals (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  clearance_id  uuid        NOT NULL UNIQUE REFERENCES app.aml_clearances(id),
  approved_by   uuid        NOT NULL REFERENCES app.accounts(id),
  approved_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_client_changes, app.aml_clearances,
  app.aml_senior_approvals FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_clearances', 'aml_senior_approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['aml_client_changes', 'aml_clearances', 'aml_senior_approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- The latest result of each measure and the latest conclusion for each kind and person.
CREATE FUNCTION app.latest_aml_measure_results(target_assessment uuid)
  RETURNS TABLE (measure_id uuid, kind text, result_id uuid, outcome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.kind, r.id, r.outcome FROM app.aml_measures m
  LEFT JOIN LATERAL (SELECT id, outcome FROM app.aml_measure_results WHERE measure_id = m.id
    ORDER BY recorded_at DESC, id DESC LIMIT 1) r ON true
  WHERE m.assessment_id = target_assessment
$$;
REVOKE ALL ON FUNCTION app.latest_aml_measure_results(uuid) FROM PUBLIC;

CREATE FUNCTION app.latest_aml_source_conclusions(target_assessment uuid)
  RETURNS TABLE (conclusion_id uuid, kind text, outcome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT ON (kind, subject_id) id, kind, outcome FROM app.aml_source_conclusions
  WHERE assessment_id = target_assessment
  ORDER BY kind, subject_id, recorded_at DESC, id DESC
$$;
REVOKE ALL ON FUNCTION app.latest_aml_source_conclusions(uuid) FROM PUBLIC;

-- Raises check_violation with a specific reason when the assessment cannot be cleared today.
CREATE FUNCTION app.assert_aml_clearable(assessment app.aml_risk_assessments) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE today date := app.london_today();
DECLARE control_row record;
BEGIN
  IF assessment.review_due_on <= today THEN
    RAISE EXCEPTION 'the assessment review date has passed' USING ERRCODE = 'check_violation';
  END IF;
  FOR control_row IN SELECT kind, control_version_id FROM app.aml_risk_assessment_controls WHERE assessment_id = assessment.id LOOP
    IF app.current_aml_control(control_row.kind, today) IS DISTINCT FROM control_row.control_version_id THEN
      RAISE EXCEPTION 'a governing firm control has changed; reassess' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF app.current_aml_country_list(today) IS DISTINCT FROM assessment.country_list_version_id THEN
    RAISE EXCEPTION 'the high-risk-country list has changed; reassess' USING ERRCODE = 'check_violation';
  END IF;
  IF assessment.cdd_case_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.aml_cdd_cases c
    WHERE c.client_id = assessment.client_id AND c.status = 'submitted'
      AND c.version > (SELECT version FROM app.aml_cdd_cases WHERE id = assessment.cdd_case_id)) THEN
    RAISE EXCEPTION 'a newer CDD case exists; reassess' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.latest_aml_measure_results(assessment.id) WHERE outcome IS DISTINCT FROM 'satisfied') THEN
    RAISE EXCEPTION 'every measure needs a satisfied latest result' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.latest_aml_source_conclusions(assessment.id) WHERE outcome <> 'satisfied') THEN
    RAISE EXCEPTION 'every source conclusion must be satisfied' USING ERRCODE = 'check_violation';
  END IF;
  IF assessment.in_scope AND (SELECT count(DISTINCT kind) FROM app.aml_measures WHERE assessment_id = assessment.id
    AND kind IN ('identity', 'beneficial_ownership', 'purpose_nature')) < 3 THEN
    RAISE EXCEPTION 'in-scope work needs identity, beneficial-ownership and purpose measures' USING ERRCODE = 'check_violation';
  END IF;
  IF assessment.rating = 'high' THEN
    IF NOT EXISTS (SELECT 1 FROM app.aml_measures WHERE assessment_id = assessment.id AND kind = 'enhanced_monitoring')
      OR NOT EXISTS (SELECT 1 FROM app.aml_measures WHERE assessment_id = assessment.id
        AND app.is_enhanced_aml_measure(kind) AND kind <> 'enhanced_monitoring') THEN
      RAISE EXCEPTION 'high risk needs enhanced monitoring and another enhanced measure' USING ERRCODE = 'check_violation';
    END IF;
    IF assessment.expected_value <> 'none' AND NOT EXISTS (SELECT 1 FROM app.latest_aml_source_conclusions(assessment.id) WHERE kind = 'funds') THEN
      RAISE EXCEPTION 'high risk needs a source-of-funds conclusion' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF assessment.pep AND NOT EXISTS (SELECT 1 FROM app.latest_aml_source_conclusions(assessment.id) WHERE kind = 'wealth') THEN
    RAISE EXCEPTION 'a PEP needs a source-of-wealth conclusion' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_aml_clearable(app.aml_risk_assessments) FROM PUBLIC;

CREATE FUNCTION app.decide_aml_clearance(target_id uuid, target_assessment uuid, selected_decision text,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
DECLARE results uuid[] := '{}';
DECLARE conclusions uuid[] := '{}';
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  assessment := app.assert_current_aml_assessment(target_assessment, actor_id);
  IF assessment.prepared_by = actor_id THEN
    RAISE EXCEPTION 'the preparer cannot clear their own assessment' USING ERRCODE = 'check_violation';
  END IF;
  -- Freeze the measure work while it is read and fixed into the clearance.
  PERFORM 1 FROM app.aml_measures WHERE assessment_id = target_assessment FOR SHARE;
  IF selected_decision = 'approved' THEN
    PERFORM app.assert_aml_clearable(assessment);
    SELECT coalesce(array_agg(result_id ORDER BY result_id), '{}') INTO results FROM app.latest_aml_measure_results(target_assessment);
    SELECT coalesce(array_agg(conclusion_id ORDER BY conclusion_id), '{}') INTO conclusions FROM app.latest_aml_source_conclusions(target_assessment);
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_clearances(id, matter_id, assessment_id, decision, needs_senior, relied_measure_results,
    relied_conclusions, encryption_context, key_version, nonce, ciphertext, auth_tag, decided_by)
  VALUES (target_id, assessment.matter_id, target_assessment, selected_decision,
    selected_decision = 'approved' AND (assessment.rating = 'high' OR assessment.pep), results, conclusions,
    selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.decide_aml_clearance(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_aml_clearance(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.approve_aml_senior(target_clearance uuid, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE clearance app.aml_clearances%ROWTYPE;
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'partner');
  SELECT * INTO clearance FROM app.aml_clearances WHERE id = target_clearance FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT * INTO assessment FROM app.aml_risk_assessments WHERE id = clearance.assessment_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_risk:' || clearance.matter_id::text, 0));
  IF NOT clearance.needs_senior THEN
    RAISE EXCEPTION 'this clearance needs no senior-management approval' USING ERRCODE = 'check_violation';
  END IF;
  IF actor_id IN (assessment.prepared_by, clearance.decided_by) THEN
    RAISE EXCEPTION 'senior approval needs a different person' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_risk_assessments WHERE matter_id = clearance.matter_id AND version > assessment.version) THEN
    RAISE EXCEPTION 'the cleared assessment has been superseded' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_senior_approvals(clearance_id, approved_by) VALUES (target_clearance, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.approve_aml_senior(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_aml_senior(uuid, uuid) TO pms_app;

-- The matter's live compliance gate. `pending`: no effective clearance. `review_due`:
-- the review date passed or a relied-on input was superseded on `due_since`; other work
-- may continue until `work_allowed_until`. `cleared`: everything relied on is current.
CREATE FUNCTION app.aml_gate(target_matter uuid, OUT state text, OUT due_since date,
  OUT work_allowed_until date, OUT clearance_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE today date := app.london_today();
DECLARE clearance app.aml_clearances%ROWTYPE;
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
DECLARE candidates date[] := '{}';
BEGIN
  SELECT c.* INTO clearance FROM app.aml_clearances c
  JOIN app.aml_risk_assessments a ON a.id = c.assessment_id
  WHERE c.matter_id = target_matter AND c.decision = 'approved'
    AND (NOT c.needs_senior OR EXISTS (SELECT 1 FROM app.aml_senior_approvals s WHERE s.clearance_id = c.id))
  ORDER BY a.version DESC LIMIT 1;
  IF NOT FOUND THEN
    state := 'pending';
    RETURN;
  END IF;
  clearance_id := clearance.id;
  SELECT * INTO assessment FROM app.aml_risk_assessments WHERE id = clearance.assessment_id;

  candidates := candidates || assessment.review_due_on;
  candidates := candidates || (SELECT min((submitted_at AT TIME ZONE 'Europe/London')::date) FROM app.aml_risk_assessments
    WHERE matter_id = target_matter AND version > assessment.version);
  candidates := candidates || (SELECT min((c.submitted_at AT TIME ZONE 'Europe/London')::date) FROM app.aml_cdd_cases c
    WHERE c.client_id = assessment.client_id AND c.status = 'submitted'
      AND c.submitted_at > coalesce((SELECT submitted_at FROM app.aml_cdd_cases WHERE id = assessment.cdd_case_id), '-infinity'));
  candidates := candidates || (SELECT min((changed_at AT TIME ZONE 'Europe/London')::date) FROM app.aml_client_changes
    WHERE client_id = assessment.client_id AND changed_at > clearance.decided_at);
  -- A relied-on control expires the day after its review date, or is superseded once a newer approved version takes effect.
  candidates := candidates || (SELECT min(least(v.review_due_on + 1, (SELECT min(greatest(n.effective_from, (p.approved_at AT TIME ZONE 'Europe/London')::date))
      FROM app.aml_control_versions n JOIN app.aml_control_approvals p ON p.control_version_id = n.id
      WHERE n.kind = v.kind AND n.version > v.version)))
    FROM app.aml_risk_assessment_controls x JOIN app.aml_control_versions v ON v.id = x.control_version_id
    WHERE x.assessment_id = assessment.id);
  candidates := candidates || (SELECT min(greatest(n.effective_from, (p.approved_at AT TIME ZONE 'Europe/London')::date))
    FROM app.aml_country_list_versions n JOIN app.aml_country_list_approvals p ON p.country_list_version_id = n.id
    JOIN app.aml_country_list_versions old ON old.id = assessment.country_list_version_id
    WHERE n.version > old.version);

  due_since := (SELECT min(day) FROM unnest(candidates) day WHERE day IS NOT NULL AND day <= today);
  IF due_since IS NULL THEN
    state := 'cleared';
  ELSE
    state := 'review_due';
    work_allowed_until := due_since + assessment.review_grace_days;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.aml_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_gate(uuid) TO pms_app;
