-- Wider conflict subjects, decision outcomes, safeguards and the combined onboarding activation gate (Step 17d).

-- 1. Client Aliases / Former Names / Trading Names
CREATE TABLE app.conflict_aliases (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id  uuid        NOT NULL REFERENCES app.clients (id),
  name       text        NOT NULL,
  kind       text        NOT NULL DEFAULT 'alias',
  notes      text,
  created_by uuid        NOT NULL REFERENCES app.accounts (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conflict_aliases_kind_valid CHECK (kind IN ('alias', 'former_name', 'trading_name')),
  CONSTRAINT conflict_aliases_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT conflict_aliases_name_safe CHECK (app.is_safe_text(name)),
  CONSTRAINT conflict_aliases_notes_safe CHECK (notes IS NULL OR (length(btrim(notes)) <= 1000 AND app.is_safe_text(notes)))
);

CREATE INDEX conflict_aliases_client_idx ON app.conflict_aliases (client_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.conflict_aliases FROM pms_app;
GRANT INSERT (client_id, name, kind, notes, created_by) ON app.conflict_aliases TO pms_app;

CREATE FUNCTION app.refuse_conflict_alias_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'conflict aliases are immutable and cannot be updated or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER conflict_aliases_fixed
  BEFORE UPDATE OR DELETE ON app.conflict_aliases
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_alias_edit();

-- 2. Connected Persons, Counterparties and Officers
CREATE TABLE app.conflict_connected_persons (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id    uuid        NOT NULL REFERENCES app.clients (id),
  name         text        NOT NULL,
  relationship text        NOT NULL,
  company_name text,
  notes        text,
  created_by   uuid        NOT NULL REFERENCES app.accounts (id),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conflict_connected_persons_rel_valid CHECK (
    relationship IN ('director', 'shareholder', 'beneficial_owner', 'connected_person', 'counterparty', 'officer', 'guarantor')
  ),
  CONSTRAINT conflict_connected_persons_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT conflict_connected_persons_name_safe CHECK (app.is_safe_text(name)),
  CONSTRAINT conflict_connected_persons_company_safe CHECK (company_name IS NULL OR (length(btrim(company_name)) <= 200 AND app.is_safe_text(company_name))),
  CONSTRAINT conflict_connected_persons_notes_safe CHECK (notes IS NULL OR (length(btrim(notes)) <= 1000 AND app.is_safe_text(notes)))
);

CREATE INDEX conflict_connected_persons_client_idx ON app.conflict_connected_persons (client_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.conflict_connected_persons FROM pms_app;
GRANT INSERT (client_id, name, relationship, company_name, notes, created_by) ON app.conflict_connected_persons TO pms_app;

CREATE TRIGGER conflict_connected_persons_fixed
  BEFORE UPDATE OR DELETE ON app.conflict_connected_persons
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_alias_edit();

-- 3. Expand conflict checks names count constraint
ALTER TABLE app.conflict_checks DROP CONSTRAINT conflict_checks_names_count;
ALTER TABLE app.conflict_checks ADD CONSTRAINT conflict_checks_names_count CHECK (cardinality(names) BETWEEN 1 AND 100);

-- 4. Update app.find_possible_conflicts to search wider conflict subjects
CREATE OR REPLACE FUNCTION app.find_possible_conflicts(checked_names text[], for_client uuid) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  BEGIN ATOMIC
    WITH wanted AS (
      SELECT DISTINCT checked, app.normalise_name(checked) AS normalised FROM unnest(checked_names) AS checked
    ),
    known AS (
      SELECT i.given_names || ' ' || i.family_name AS name,
             CASE WHEN cl.status = 'archived' THEN 'former_client' ELSE 'client' END AS relation,
             i.client_id, NULL::uuid AS matter_id
        FROM app.client_individuals i
        JOIN app.clients cl ON cl.id = i.client_id
      UNION ALL
      SELECT o.legal_name,
             CASE WHEN cl.status = 'archived' THEN 'former_client' ELSE 'client' END,
             o.client_id, NULL
        FROM app.client_organisations o
        JOIN app.clients cl ON cl.id = o.client_id
      UNION ALL
      SELECT c.given_names || ' ' || c.family_name, 'contact', c.client_id, NULL
        FROM app.client_contacts c
      UNION ALL
      SELECT p.name, CASE p.role WHEN 'other' THEN 'other_party' ELSE p.role END, m.client_id, m.id
        FROM app.matter_parties p JOIN app.matters m ON m.id = p.matter_id
      UNION ALL
      SELECT a.name, 'alias', a.client_id, NULL
        FROM app.conflict_aliases a
      UNION ALL
      SELECT cp.name,
             CASE WHEN cp.relationship = 'counterparty' THEN 'counterparty' ELSE 'connected_person' END,
             cp.client_id, NULL
        FROM app.conflict_connected_persons cp
    ),
    found AS (
      SELECT w.checked, k.name, k.relation, k.client_id, k.matter_id,
        app.name_likeness(w.normalised, app.normalise_name(k.name)) AS score
      FROM wanted w CROSS JOIN known k
      WHERE NOT (k.client_id = for_client AND k.relation IN ('client', 'former_client', 'contact', 'alias', 'connected_person'))
    ),
    possible AS (
      SELECT * FROM found WHERE score >= 0.3
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM possible),
      'matches', coalesce(
        (SELECT jsonb_agg(
           jsonb_build_object(
             'checkedName', checked, 'matchedName', name, 'relation', relation,
             'clientId', client_id, 'matterId', matter_id, 'score', score
           )
           ORDER BY score DESC, name
         )
         FROM (SELECT * FROM possible ORDER BY score DESC, name LIMIT 50) AS strongest),
        '[]'::jsonb
      )
    );
  END;

-- 5. Conflict Decisions with outcomes, rationale, and safeguards
CREATE TABLE app.conflict_decisions (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  check_id    uuid        NOT NULL REFERENCES app.conflict_checks (id),
  client_id   uuid        NOT NULL REFERENCES app.clients (id),
  outcome     text        NOT NULL,
  rationale   text        NOT NULL,
  safeguards  text[]      NOT NULL DEFAULT '{}',
  decided_by  uuid        NOT NULL REFERENCES app.accounts (id),
  decided_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conflict_decisions_outcome_valid CHECK (
    outcome IN ('clear', 'potential', 'escalated', 'approved_with_controls', 'cannot_act')
  ),
  CONSTRAINT conflict_decisions_rationale_length CHECK (length(btrim(rationale)) BETWEEN 10 AND 2000),
  CONSTRAINT conflict_decisions_rationale_safe CHECK (app.is_safe_text(rationale))
);

CREATE INDEX conflict_decisions_client_idx ON app.conflict_decisions (client_id, decided_at DESC);
CREATE INDEX conflict_decisions_check_idx ON app.conflict_decisions (check_id, decided_at DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.conflict_decisions FROM pms_app;

CREATE TRIGGER conflict_decisions_fixed
  BEFORE UPDATE OR DELETE ON app.conflict_decisions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_alias_edit();

CREATE OR REPLACE FUNCTION app.record_conflict_decision(
  target_check_id uuid,
  target_client_id uuid,
  target_outcome text,
  target_rationale text,
  target_safeguards text[],
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_id uuid := uuidv7();
  ch_row app.conflict_checks%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.accounts a
    JOIN app.account_roles ar ON ar.account_id = a.id
    WHERE a.id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'compliance', 'fee_earner')
      AND ar.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Only authorized fee earners, partners or compliance staff can record conflict decisions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- escalated or cannot_act or approved_with_controls requires partner or compliance
  IF target_outcome IN ('approved_with_controls', 'cannot_act', 'escalated') THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.accounts a
      JOIN app.account_roles ar ON ar.account_id = a.id
      WHERE a.id = actor_id AND a.status = 'active'
        AND ar.role IN ('partner', 'compliance')
        AND ar.revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Escalated, restricted or approved_with_controls decisions require partner or compliance approval'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO ch_row FROM app.conflict_checks WHERE id = target_check_id AND client_id = target_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conflict check not found for this client'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO app.conflict_decisions (id, check_id, client_id, outcome, rationale, safeguards, decided_by)
  VALUES (new_id, target_check_id, target_client_id, target_outcome, target_rationale, coalesce(target_safeguards, '{}'::text[]), actor_id);

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.record_conflict_decision(uuid, uuid, text, text, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_conflict_decision(uuid, uuid, text, text, text[], uuid) TO pms_app;

-- 6. Activation Exceptions (time-limited, reasoned waivers for onboarding requirements)
CREATE TABLE app.onboarding_activation_exceptions (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id       uuid        NOT NULL REFERENCES app.clients (id),
  requirement_key text        NOT NULL,
  reason          text        NOT NULL,
  expires_at      timestamptz NOT NULL,
  granted_by      uuid        NOT NULL REFERENCES app.accounts (id),
  granted_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT onboarding_exceptions_req_valid CHECK (
    requirement_key IN ('conflict_check', 'email_verification', 'id_verification', 'cdd_compliance')
  ),
  CONSTRAINT onboarding_exceptions_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT onboarding_exceptions_reason_safe CHECK (app.is_safe_text(reason)),
  CONSTRAINT onboarding_exceptions_duration_valid CHECK (
    expires_at > granted_at AND expires_at <= granted_at + interval '60 days'
  )
);

CREATE INDEX onboarding_activation_exceptions_client_idx ON app.onboarding_activation_exceptions (client_id, expires_at DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.onboarding_activation_exceptions FROM pms_app;

CREATE TRIGGER onboarding_activation_exceptions_fixed
  BEFORE UPDATE OR DELETE ON app.onboarding_activation_exceptions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_alias_edit();

CREATE OR REPLACE FUNCTION app.grant_activation_exception(
  target_client_id uuid,
  target_req_key text,
  target_reason text,
  target_expires_at timestamptz,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_id uuid := uuidv7();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.accounts a
    JOIN app.account_roles ar ON ar.account_id = a.id
    WHERE a.id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'compliance')
      AND ar.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Only partners or compliance staff can grant activation exceptions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO app.onboarding_activation_exceptions (id, client_id, requirement_key, reason, expires_at, granted_by)
  VALUES (new_id, target_client_id, target_req_key, target_reason, target_expires_at, actor_id);

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.grant_activation_exception(uuid, text, text, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.grant_activation_exception(uuid, text, text, timestamptz, uuid) TO pms_app;

-- 7. Client Onboarding Activations (Final Gate Action)
CREATE TABLE app.client_onboarding_activations (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id    uuid        NOT NULL UNIQUE REFERENCES app.clients (id),
  activated_by uuid        NOT NULL REFERENCES app.accounts (id),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  notes        text,

  CONSTRAINT client_onboarding_activations_notes_safe CHECK (
    notes IS NULL OR (length(btrim(notes)) <= 1000 AND app.is_safe_text(notes))
  )
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.client_onboarding_activations FROM pms_app;

CREATE TRIGGER client_onboarding_activations_fixed
  BEFORE UPDATE OR DELETE ON app.client_onboarding_activations
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_alias_edit();

-- 8. Gate Evaluation Function
CREATE OR REPLACE FUNCTION app.evaluate_client_activation_gate(target_client uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  client_row app.clients%ROWTYPE;
  activation_row app.client_onboarding_activations%ROWTYPE;
  latest_check app.conflict_checks%ROWTYPE;
  latest_decision app.conflict_decisions%ROWTYPE;
  
  conflict_status text := 'pending';
  conflict_details text := 'No conflict check has been run';
  conflict_reviewer text := NULL;
  conflict_last_event timestamptz := NULL;

  email_status text := 'pending';
  email_details text := 'No verified email address recorded';
  email_last_event timestamptz := NULL;

  id_status text := 'pending';
  id_details text := 'No verified identity or company evidence';
  id_last_event timestamptz := NULL;

  cdd_status text := 'pending';
  cdd_details text := 'No CDD or compliance case submitted';
  cdd_last_event timestamptz := NULL;

  has_hold boolean := false;
  overall_status text := 'pending';
  can_activate boolean := false;

  exception_conflict app.onboarding_activation_exceptions%ROWTYPE;
  exception_email app.onboarding_activation_exceptions%ROWTYPE;
  exception_id app.onboarding_activation_exceptions%ROWTYPE;
  exception_cdd app.onboarding_activation_exceptions%ROWTYPE;

  now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO client_row FROM app.clients WHERE id = target_client;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO activation_row FROM app.client_onboarding_activations WHERE client_id = target_client;

  -- 1. Evaluate Conflict Check
  SELECT * INTO latest_check FROM app.conflict_checks
  WHERE client_id = target_client ORDER BY created_at DESC LIMIT 1;

  IF latest_check.id IS NOT NULL THEN
    conflict_last_event := latest_check.created_at;
    IF latest_check.match_count = 0 THEN
      conflict_status := 'satisfied';
      conflict_details := 'Conflict search found 0 matches (clear)';
    ELSE
      -- Check decisions
      SELECT * INTO latest_decision FROM app.conflict_decisions
      WHERE check_id = latest_check.id ORDER BY decided_at DESC LIMIT 1;

      IF latest_decision.id IS NOT NULL THEN
        conflict_last_event := latest_decision.decided_at;
        SELECT a.display_name INTO conflict_reviewer FROM app.accounts a WHERE a.id = latest_decision.decided_by;
        IF latest_decision.outcome IN ('clear', 'approved_with_controls') THEN
          conflict_status := 'satisfied';
          conflict_details := 'Decision: ' || latest_decision.outcome || ' - ' || latest_decision.rationale;
        ELSIF latest_decision.outcome = 'cannot_act' THEN
          conflict_status := 'blocked';
          conflict_details := 'Decision: cannot act - ' || latest_decision.rationale;
        ELSIF latest_decision.outcome = 'escalated' THEN
          conflict_status := 'blocked';
          conflict_details := 'Decision: escalated for partner review - ' || latest_decision.rationale;
        ELSE
          conflict_status := 'pending';
          conflict_details := 'Potential conflicts awaiting review (' || latest_check.match_count || ' matches)';
        END IF;
      ELSE
        conflict_status := 'pending';
        conflict_details := 'Potential conflicts found (' || latest_check.match_count || ' matches) - awaiting review';
      END IF;
    END IF;
  END IF;

  -- 2. Evaluate Email Verification
  SELECT verified_at INTO email_last_event FROM app.contact_verification_requests
  WHERE client_id = target_client AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1;
  IF email_last_event IS NOT NULL THEN
    email_status := 'satisfied';
    email_details := 'Email channel verified';
  END IF;

  -- 3. Evaluate Identity / Company Evidence
  IF client_row.kind = 'individual' THEN
    -- Check accepted evidence review or passing electronic check
    SELECT r.reviewed_at INTO id_last_event FROM app.onboarding_evidence_reviews r
    JOIN app.onboarding_evidence_requests req ON req.id = r.request_id
    WHERE req.client_id = target_client AND r.outcome = 'accepted'
    ORDER BY r.reviewed_at DESC LIMIT 1;

    IF id_last_event IS NOT NULL THEN
      id_status := 'satisfied';
      id_details := 'Submitted identity evidence reviewed and accepted';
    ELSE
      SELECT check_date::timestamptz INTO id_last_event FROM app.onboarding_electronic_checks
      WHERE client_id = target_client AND result = 'pass'
      ORDER BY check_date DESC LIMIT 1;

      IF id_last_event IS NOT NULL THEN
        id_status := 'satisfied';
        id_details := 'Electronic identity check passed';
      END IF;
    END IF;
  ELSE
    -- Organisation: check company snapshot or accepted evidence review
    SELECT retrieved_at INTO id_last_event FROM app.onboarding_company_snapshots
    WHERE client_id = target_client ORDER BY retrieved_at DESC LIMIT 1;

    IF id_last_event IS NOT NULL THEN
      id_status := 'satisfied';
      id_details := 'Companies House registry snapshot recorded';
    ELSE
      SELECT r.reviewed_at INTO id_last_event FROM app.onboarding_evidence_reviews r
      JOIN app.onboarding_evidence_requests req ON req.id = r.request_id
      WHERE req.client_id = target_client AND r.outcome = 'accepted'
      ORDER BY r.reviewed_at DESC LIMIT 1;

      IF id_last_event IS NOT NULL THEN
        id_status := 'satisfied';
        id_details := 'Company registry / authority evidence accepted';
      END IF;
    END IF;
  END IF;

  -- 4. Evaluate CDD / AML Compliance
  SELECT EXISTS (
    SELECT 1 FROM app.aml_holds h
    WHERE h.client_id = target_client
      AND NOT EXISTS (SELECT 1 FROM app.aml_hold_lifts l WHERE l.hold_id = h.id)
  ) INTO has_hold;

  IF has_hold THEN
    cdd_status := 'blocked';
    cdd_details := 'Active AML hold on client';
  ELSE
    SELECT submitted_at INTO cdd_last_event FROM app.aml_cdd_cases
    WHERE client_id = target_client AND status = 'submitted'
    ORDER BY version DESC LIMIT 1;

    IF cdd_last_event IS NOT NULL THEN
      cdd_status := 'satisfied';
      cdd_details := 'CDD compliance case submitted';
    ELSE
      -- Also check if draft exists
      SELECT created_at INTO cdd_last_event FROM app.aml_cdd_cases
      WHERE client_id = target_client ORDER BY version DESC LIMIT 1;
      IF cdd_last_event IS NOT NULL THEN
        cdd_status := 'pending';
        cdd_details := 'CDD case is in draft, not yet submitted';
      ELSE
        cdd_status := 'pending';
        cdd_details := 'No CDD case opened';
      END IF;
    END IF;
  END IF;

  -- 5. Check Exceptions
  IF conflict_status <> 'satisfied' AND conflict_status <> 'blocked' THEN
    SELECT * INTO exception_conflict FROM app.onboarding_activation_exceptions
    WHERE client_id = target_client AND requirement_key = 'conflict_check' AND expires_at > now
    ORDER BY expires_at DESC LIMIT 1;
    IF exception_conflict.id IS NOT NULL THEN
      conflict_status := 'exception';
      conflict_details := 'Exception granted until ' || exception_conflict.expires_at::date::text || ': ' || exception_conflict.reason;
    END IF;
  END IF;

  IF email_status <> 'satisfied' THEN
    SELECT * INTO exception_email FROM app.onboarding_activation_exceptions
    WHERE client_id = target_client AND requirement_key = 'email_verification' AND expires_at > now
    ORDER BY expires_at DESC LIMIT 1;
    IF exception_email.id IS NOT NULL THEN
      email_status := 'exception';
      email_details := 'Exception granted until ' || exception_email.expires_at::date::text || ': ' || exception_email.reason;
    END IF;
  END IF;

  IF id_status <> 'satisfied' THEN
    SELECT * INTO exception_id FROM app.onboarding_activation_exceptions
    WHERE client_id = target_client AND requirement_key = 'id_verification' AND expires_at > now
    ORDER BY expires_at DESC LIMIT 1;
    IF exception_id.id IS NOT NULL THEN
      id_status := 'exception';
      id_details := 'Exception granted until ' || exception_id.expires_at::date::text || ': ' || exception_id.reason;
    END IF;
  END IF;

  IF cdd_status <> 'satisfied' AND NOT has_hold THEN
    SELECT * INTO exception_cdd FROM app.onboarding_activation_exceptions
    WHERE client_id = target_client AND requirement_key = 'cdd_compliance' AND expires_at > now
    ORDER BY expires_at DESC LIMIT 1;
    IF exception_cdd.id IS NOT NULL THEN
      cdd_status := 'exception';
      cdd_details := 'Exception granted until ' || exception_cdd.expires_at::date::text || ': ' || exception_cdd.reason;
    END IF;
  END IF;

  -- 6. Overall gate state
  IF activation_row.id IS NOT NULL THEN
    overall_status := 'activated';
    can_activate := false;
  ELSIF conflict_status = 'blocked' OR cdd_status = 'blocked' THEN
    overall_status := 'blocked';
    can_activate := false;
  ELSIF conflict_status IN ('satisfied', 'exception')
    AND email_status IN ('satisfied', 'exception')
    AND id_status IN ('satisfied', 'exception')
    AND cdd_status IN ('satisfied', 'exception') THEN
    overall_status := 'ready';
    can_activate := true;
  ELSE
    overall_status := 'pending';
    can_activate := false;
  END IF;

  RETURN jsonb_build_object(
    'status', overall_status,
    'canActivate', can_activate,
    'isActivated', activation_row.id IS NOT NULL,
    'activatedAt', activation_row.activated_at,
    'activatedBy', activation_row.activated_by,
    'notes', activation_row.notes,
    'requirements', jsonb_build_array(
      jsonb_build_object(
        'key', 'conflict_check',
        'title', 'Conflict search and resolution',
        'status', conflict_status,
        'details', conflict_details,
        'reviewer', conflict_reviewer,
        'lastEventAt', conflict_last_event
      ),
      jsonb_build_object(
        'key', 'email_verification',
        'title', 'Email contact verification',
        'status', email_status,
        'details', email_details,
        'lastEventAt', email_last_event
      ),
      jsonb_build_object(
        'key', 'id_verification',
        'title', 'Identity and company evidence',
        'status', id_status,
        'details', id_details,
        'lastEventAt', id_last_event
      ),
      jsonb_build_object(
        'key', 'cdd_compliance',
        'title', 'CDD and compliance checks',
        'status', cdd_status,
        'details', cdd_details,
        'lastEventAt', cdd_last_event
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION app.evaluate_client_activation_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.evaluate_client_activation_gate(uuid) TO pms_app;

-- 9. Activation Action Function
CREATE OR REPLACE FUNCTION app.activate_client_onboarding(
  target_client uuid,
  notes text,
  actor_id uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  gate jsonb;
  new_id uuid := uuidv7();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.accounts a
    JOIN app.account_roles ar ON ar.account_id = a.id
    WHERE a.id = actor_id AND a.status = 'active'
      AND ar.role IN ('partner', 'compliance')
      AND ar.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Only partners or compliance staff can formally activate a client'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  gate := app.evaluate_client_activation_gate(target_client);
  IF gate IS NULL THEN
    RAISE EXCEPTION 'Client not found' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT (gate ->> 'canActivate')::boolean AND NOT (gate ->> 'isActivated')::boolean THEN
    RAISE EXCEPTION 'Client onboarding requirements are not satisfied'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.client_onboarding_activations (id, client_id, activated_by, notes)
  VALUES (new_id, target_client, actor_id, notes);

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION app.activate_client_onboarding(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.activate_client_onboarding(uuid, text, uuid) TO pms_app;
