-- Compliance / AML step 15d-2: sanctions screening of clients and CDD subjects,
-- human resolution of candidates, and the effect of matches on the compliance gate.

CREATE TABLE app.aml_screenings (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id    uuid        NOT NULL REFERENCES app.clients(id),
  list_id      uuid        NOT NULL REFERENCES app.aml_sanctions_lists(id),
  -- 'client' for the client record, otherwise the id of a CDD subject of this client.
  subject_ref  text        NOT NULL,
  screened_by  uuid        REFERENCES app.accounts(id),
  screened_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_screenings_subject_valid CHECK (
    subject_ref = 'client' OR subject_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);
CREATE INDEX aml_screenings_client_idx ON app.aml_screenings (client_id, subject_ref, screened_at DESC);

CREATE TABLE app.aml_screening_candidates (
  id                 uuid    PRIMARY KEY DEFAULT uuidv7(),
  screening_id       uuid    NOT NULL REFERENCES app.aml_screenings(id),
  list_id            uuid    NOT NULL,
  unique_id          text    NOT NULL,
  matched_name       text    NOT NULL,
  birth_agreement    text    NOT NULL,
  -- The designation's names, kind and births at screening; a change reopens a false positive.
  designation_print  bytea   NOT NULL,
  carried_from       uuid,
  FOREIGN KEY (list_id, unique_id) REFERENCES app.aml_sanctions_designations(list_id, unique_id),
  UNIQUE (screening_id, unique_id),

  CONSTRAINT aml_screening_candidates_birth_valid CHECK (birth_agreement IN ('match', 'conflict', 'unknown')),
  CONSTRAINT aml_screening_candidates_print_valid CHECK (octet_length(designation_print) = 32)
);
CREATE INDEX aml_screening_candidates_screening_idx ON app.aml_screening_candidates (screening_id);

CREATE TABLE app.aml_candidate_resolutions (
  id                  uuid        PRIMARY KEY,
  candidate_id        uuid        NOT NULL UNIQUE REFERENCES app.aml_screening_candidates(id),
  outcome             text        NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  resolved_by         uuid        NOT NULL REFERENCES app.accounts(id),
  resolved_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_candidate_resolutions_outcome_valid CHECK (outcome IN ('false_positive', 'confirmed')),
  CONSTRAINT aml_candidate_resolutions_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_candidate_resolutions_context_valid CHECK (encryption_context = 'aml-resolution:' || id::text)
);
ALTER TABLE app.aml_screening_candidates
  ADD CONSTRAINT aml_screening_candidates_carried_fk FOREIGN KEY (carried_from) REFERENCES app.aml_candidate_resolutions(id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_screenings, app.aml_screening_candidates,
  app.aml_candidate_resolutions FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_screenings', 'aml_screening_candidates', 'aml_candidate_resolutions'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- What a designation looked like on a list: a later change to it reopens a false positive.
CREATE FUNCTION app.aml_designation_print(target_list uuid, target_unique text) RETURNS bytea
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT sha256(convert_to(
    d.kind || '|' || array_to_string(d.births, ',') || '|' ||
    coalesce((SELECT string_agg(n.normalized, ',' ORDER BY n.normalized) FROM app.aml_sanctions_names n
      WHERE n.list_id = d.list_id AND n.unique_id = d.unique_id), ''), 'UTF8'))
  FROM app.aml_sanctions_designations d WHERE d.list_id = target_list AND d.unique_id = target_unique
$$;
REVOKE ALL ON FUNCTION app.aml_designation_print(uuid, text) FROM PUBLIC;

-- The latest moment the identity screened for this client could have changed:
-- a client-record edit or a newer submitted CDD case.
CREATE FUNCTION app.aml_identity_changed_at(target_client uuid) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT greatest(
    (SELECT max(changed_at) FROM app.aml_client_changes WHERE client_id = target_client),
    (SELECT max(submitted_at) FROM app.aml_cdd_cases WHERE client_id = target_client AND status = 'submitted'),
    (SELECT created_at FROM app.clients WHERE id = target_client))
$$;
REVOKE ALL ON FUNCTION app.aml_identity_changed_at(uuid) FROM PUBLIC;

-- Records one screening of one subject against the active list. `candidates` is
-- [{unique_id, matched_name, birth_agreement}] as the API's matcher found them. A false
-- positive is carried forward only for the same subject and designation, both unchanged
-- since that resolution. `actor_id` is null for the scheduled rescreen.
CREATE FUNCTION app.record_aml_screening(target_client uuid, target_list uuid, selected_subject text,
  candidates jsonb, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
DECLARE active_list uuid;
BEGIN
  IF actor_id IS NOT NULL THEN PERFORM app.assert_aml_client_access(actor_id, target_client); END IF;
  PERFORM 1 FROM app.clients WHERE id = target_client FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT list_id INTO active_list FROM app.aml_sanctions_status();
  IF active_list IS DISTINCT FROM target_list THEN
    RAISE EXCEPTION 'screen against the active sanctions list' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_subject <> 'client' AND NOT EXISTS (SELECT 1 FROM app.aml_cdd_subjects s
    JOIN app.aml_cdd_cases c ON c.id = s.cdd_case_id WHERE s.id::text = selected_subject AND c.client_id = target_client) THEN
    RAISE EXCEPTION 'the subject must belong to this client' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(target_client));
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_screenings(client_id, list_id, subject_ref, screened_by)
    VALUES (target_client, target_list, selected_subject, actor_id) RETURNING id INTO created_id;
  INSERT INTO app.aml_screening_candidates(screening_id, list_id, unique_id, matched_name, birth_agreement, designation_print, carried_from)
    SELECT created_id, target_list, c.unique_id, c.matched_name, c.birth_agreement,
      app.aml_designation_print(target_list, c.unique_id),
      (SELECT r.id FROM app.aml_candidate_resolutions r
        JOIN app.aml_screening_candidates old ON old.id = r.candidate_id
        JOIN app.aml_screenings s ON s.id = old.screening_id
        WHERE r.outcome = 'false_positive' AND s.client_id = target_client AND s.subject_ref = selected_subject
          AND old.unique_id = c.unique_id AND old.designation_print = app.aml_designation_print(target_list, c.unique_id)
          AND r.resolved_at > coalesce(app.aml_identity_changed_at(target_client), '-infinity')
        ORDER BY r.resolved_at DESC LIMIT 1)
    FROM jsonb_to_recordset(candidates) AS c(unique_id text, matched_name text, birth_agreement text);
  PERFORM set_config('app.aml_risk_write', '0', true);
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_screening(uuid, uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_screening(uuid, uuid, text, jsonb, uuid) TO pms_app;

CREATE FUNCTION app.resolve_aml_candidate(target_id uuid, target_candidate uuid, selected_outcome text,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_client uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT s.client_id INTO target_client FROM app.aml_screening_candidates c
    JOIN app.aml_screenings s ON s.id = c.screening_id WHERE c.id = target_candidate;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(target_client));
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_candidate_resolutions(id, candidate_id, outcome, encryption_context, key_version, nonce, ciphertext, auth_tag, resolved_by)
    VALUES (target_id, target_candidate, selected_outcome, selected_context, selected_key, selected_nonce, selected_ciphertext,
      selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.resolve_aml_candidate(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_aml_candidate(uuid, uuid, text, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

-- A client's sanctions position, worst first:
--   confirmed       a candidate was confirmed as the designated person or entity;
--   possible_match  a candidate is unresolved;
--   stale           the active list is missing or stale;
--   unscreened      the client record or a subject of its latest CDD case has no
--                   screening against the active list since its identity last changed;
--   clear           otherwise.
CREATE FUNCTION app.aml_sanctions_state(target_client uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE list_status record;
DECLARE changed timestamptz := app.aml_identity_changed_at(target_client);
DECLARE latest_screenings uuid[];
BEGIN
  -- Matches on any list stay in force until resolved: a new list does not erase a concern.
  IF EXISTS (SELECT 1 FROM app.aml_screening_candidates c JOIN app.aml_screenings s ON s.id = c.screening_id
    JOIN app.aml_candidate_resolutions r ON r.candidate_id = c.id
    WHERE s.client_id = target_client AND r.outcome = 'confirmed') THEN
    RETURN 'confirmed';
  END IF;
  SELECT array_agg(id) INTO latest_screenings FROM (
    SELECT DISTINCT ON (subject_ref) id FROM app.aml_screenings WHERE client_id = target_client
    ORDER BY subject_ref, screened_at DESC, id DESC) latest;
  IF EXISTS (SELECT 1 FROM app.aml_screening_candidates c WHERE c.screening_id = ANY (coalesce(latest_screenings, '{}'))
    AND c.carried_from IS NULL AND NOT EXISTS (SELECT 1 FROM app.aml_candidate_resolutions r WHERE r.candidate_id = c.id)) THEN
    RETURN 'possible_match';
  END IF;
  SELECT * INTO list_status FROM app.aml_sanctions_status();
  IF NOT list_status.fresh THEN RETURN 'stale'; END IF;
  IF EXISTS (
    SELECT ref FROM (SELECT 'client' AS ref UNION ALL
      SELECT s.id::text FROM app.aml_cdd_subjects s WHERE s.cdd_case_id = (SELECT id FROM app.aml_cdd_cases
        WHERE client_id = target_client AND status = 'submitted' ORDER BY version DESC LIMIT 1)) required
    WHERE NOT EXISTS (SELECT 1 FROM app.aml_screenings sc WHERE sc.client_id = target_client AND sc.subject_ref = required.ref
      AND sc.list_id = list_status.list_id AND sc.screened_at >= coalesce(changed, '-infinity'))
  ) THEN
    RETURN 'unscreened';
  END IF;
  RETURN 'clear';
END;
$$;
REVOKE ALL ON FUNCTION app.aml_sanctions_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_sanctions_state(uuid) TO pms_app;

-- Clearance needs a clear sanctions position, whatever function inserts it.
CREATE FUNCTION app.require_clear_sanctions_for_clearance() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.decision = 'approved' AND app.aml_sanctions_state((SELECT client_id FROM app.matters WHERE id = NEW.matter_id)) <> 'clear' THEN
    RAISE EXCEPTION 'clearance needs current, clear sanctions screening' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.require_clear_sanctions_for_clearance() FROM PUBLIC;
CREATE TRIGGER aml_clearances_require_sanctions BEFORE INSERT ON app.aml_clearances
  FOR EACH ROW EXECUTE FUNCTION app.require_clear_sanctions_for_clearance();

-- 15c-4's gate, now also `held` while a sanctions candidate is unresolved or confirmed.
CREATE OR REPLACE FUNCTION app.aml_gate(target_matter uuid, OUT state text, OUT due_since date,
  OUT work_allowed_until date, OUT clearance_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE today date := app.london_today();
DECLARE clearance app.aml_clearances%ROWTYPE;
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
DECLARE candidates date[] := '{}';
BEGIN
  IF app.has_active_aml_hold(target_matter)
    OR app.aml_sanctions_state((SELECT client_id FROM app.matters WHERE id = target_matter)) IN ('possible_match', 'confirmed') THEN
    state := 'held';
    RETURN;
  END IF;
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
    work_allowed_until := due_since + assessment.review_grace_days - 1;
  END IF;
END;
$$;

-- 15c-4's enforcement, now also refusing money unless sanctions screening is current and clear.
CREATE OR REPLACE FUNCTION app.assert_aml_gate(target_matter uuid, selected_action text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE gate record;
DECLARE matter_client uuid;
DECLARE today date := app.london_today();
BEGIN
  SELECT client_id INTO matter_client FROM app.matters WHERE id = target_matter;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock_shared(app.aml_matter_lock_key(target_matter));
  PERFORM pg_advisory_xact_lock_shared(app.aml_client_lock_key(matter_client));
  SELECT * INTO gate FROM app.aml_gate(target_matter);
  IF selected_action = 'money' AND app.aml_sanctions_state(matter_client) <> 'clear' THEN
    RAISE EXCEPTION 'compliance clearance is required for this action' USING ERRCODE = 'check_violation';
  END IF;
  IF gate.state = 'cleared' THEN RETURN; END IF;
  IF gate.state = 'review_due' AND selected_action <> 'money' AND today <= gate.work_allowed_until THEN RETURN; END IF;
  IF gate.state = 'pending' AND selected_action IN ('time', 'documents') AND EXISTS (
    SELECT 1 FROM app.aml_start_exceptions e
    JOIN app.aml_exception_approvals p ON p.exception_id = e.id
    WHERE e.matter_id = target_matter AND e.expires_on >= today AND selected_action = ANY (e.permitted_actions)
      AND e.assessment_id = (SELECT id FROM app.aml_risk_assessments WHERE matter_id = target_matter ORDER BY version DESC LIMIT 1)
  ) THEN RETURN; END IF;
  RAISE EXCEPTION 'compliance clearance is required for this action' USING ERRCODE = 'check_violation';
END;
$$;

-- Clients with matters still open, for rescreening after a new list.
CREATE FUNCTION app.aml_clients_to_rescreen(after_client uuid, max_rows integer) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT m.client_id FROM app.matters m
  WHERE m.status <> 'closed' AND (after_client IS NULL OR m.client_id > after_client)
  ORDER BY m.client_id LIMIT least(greatest(max_rows, 1), 500)
$$;
REVOKE ALL ON FUNCTION app.aml_clients_to_rescreen(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_clients_to_rescreen(uuid, integer) TO pms_app;

-- The review queue, now paged newest first with a `before` cursor like every other list,
-- so a long backlog never hides a matter behind the first page.
DROP FUNCTION app.aml_review_queue(integer);
CREATE FUNCTION app.aml_review_queue(max_rows integer, before_matter uuid)
  RETURNS TABLE (matter_id uuid, state text, due_since date, work_allowed_until date, review_due_on date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, g.state, g.due_since, g.work_allowed_until, latest.review_due_on
  FROM app.matters m
  CROSS JOIN LATERAL app.aml_gate(m.id) g
  LEFT JOIN LATERAL (SELECT review_due_on FROM app.aml_risk_assessments WHERE matter_id = m.id
    ORDER BY version DESC LIMIT 1) latest ON true
  WHERE m.status <> 'closed' AND (before_matter IS NULL OR m.id < before_matter)
    AND (g.state <> 'cleared' OR latest.review_due_on <= app.london_today() + 30)
  ORDER BY m.id DESC
  LIMIT least(greatest(max_rows, 1), 100)
$$;
REVOKE ALL ON FUNCTION app.aml_review_queue(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_review_queue(integer, uuid) TO pms_app;
