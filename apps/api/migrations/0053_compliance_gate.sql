-- Compliance / AML step 15c-4: holds, the early-verification exception, the
-- ongoing-review queue, and enforcement of the gate on time, billing, documents
-- and money movement.

CREATE TABLE app.aml_holds (
  id                  uuid        PRIMARY KEY,
  client_id           uuid        NOT NULL REFERENCES app.clients(id),
  matter_id           uuid        REFERENCES app.matters(id),
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  imposed_by          uuid        NOT NULL REFERENCES app.accounts(id),
  imposed_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_holds_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_holds_context_valid CHECK (encryption_context = 'aml-hold:' || id::text)
);
CREATE INDEX aml_holds_client_idx ON app.aml_holds (client_id);
CREATE INDEX aml_holds_matter_idx ON app.aml_holds (matter_id) WHERE matter_id IS NOT NULL;

CREATE TABLE app.aml_hold_lifts (
  id                  uuid        PRIMARY KEY,
  hold_id             uuid        NOT NULL UNIQUE REFERENCES app.aml_holds(id),
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  lifted_by           uuid        NOT NULL REFERENCES app.accounts(id),
  lifted_at           timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_hold_lifts_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_hold_lifts_context_valid CHECK (encryption_context = 'aml-hold-lift:' || id::text)
);

CREATE TABLE app.aml_start_exceptions (
  id                  uuid        PRIMARY KEY,
  matter_id           uuid        NOT NULL REFERENCES app.matters(id),
  assessment_id       uuid        NOT NULL REFERENCES app.aml_risk_assessments(id),
  permitted_actions   text[]      NOT NULL,
  expires_on          date        NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  granted_by          uuid        NOT NULL REFERENCES app.accounts(id),
  granted_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Never money: the exception exists for early work, not for receiving or releasing funds.
  CONSTRAINT aml_start_exceptions_actions_valid CHECK (
    permitted_actions IN (ARRAY['documents'], ARRAY['time'], ARRAY['documents', 'time'])
  ),
  CONSTRAINT aml_start_exceptions_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_start_exceptions_context_valid CHECK (encryption_context = 'aml-exception:' || id::text)
);
CREATE INDEX aml_start_exceptions_matter_idx ON app.aml_start_exceptions (matter_id, expires_on DESC);

CREATE TABLE app.aml_exception_approvals (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  exception_id  uuid        NOT NULL UNIQUE REFERENCES app.aml_start_exceptions(id),
  approved_by   uuid        NOT NULL REFERENCES app.accounts(id),
  approved_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_holds, app.aml_hold_lifts,
  app.aml_start_exceptions, app.aml_exception_approvals FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_holds', 'aml_hold_lifts', 'aml_start_exceptions', 'aml_exception_approvals'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- Gate checks take these locks shared; holds, assessments and clearances take them
-- exclusively, so a hold and a payment cannot each commit believing it won.
CREATE FUNCTION app.aml_matter_lock_key(target_matter uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT hashtextextended('app.aml_risk:' || target_matter::text, 0)
$$;
REVOKE ALL ON FUNCTION app.aml_matter_lock_key(uuid) FROM PUBLIC;
CREATE FUNCTION app.aml_client_lock_key(target_client uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT hashtextextended('app.aml_hold_client:' || target_client::text, 0)
$$;
REVOKE ALL ON FUNCTION app.aml_client_lock_key(uuid) FROM PUBLIC;

CREATE FUNCTION app.impose_aml_hold(target_id uuid, target_client uuid, target_matter uuid,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hold_client uuid := target_client;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  IF target_matter IS NOT NULL THEN
    SELECT client_id INTO hold_client FROM app.matters WHERE id = target_matter FOR SHARE;
    IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
    PERFORM pg_advisory_xact_lock(app.aml_matter_lock_key(target_matter));
  ELSE
    PERFORM 1 FROM app.clients WHERE id = hold_client FOR SHARE;
    IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
    PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(hold_client));
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_holds(id, client_id, matter_id, encryption_context, key_version, nonce, ciphertext, auth_tag, imposed_by)
    VALUES (target_id, hold_client, target_matter, selected_context, selected_key, selected_nonce, selected_ciphertext,
      selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.impose_aml_hold(uuid, uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.impose_aml_hold(uuid, uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.lift_aml_hold(target_id uuid, target_hold uuid,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hold app.aml_holds%ROWTYPE;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT * INTO hold FROM app.aml_holds WHERE id = target_hold FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_hold_lifts(id, hold_id, encryption_context, key_version, nonce, ciphertext, auth_tag, lifted_by)
    VALUES (target_id, target_hold, selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.lift_aml_hold(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lift_aml_hold(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.has_active_aml_hold(target_matter uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.aml_holds h JOIN app.matters m ON m.id = target_matter
    WHERE (h.matter_id = target_matter OR (h.matter_id IS NULL AND h.client_id = m.client_id))
      AND NOT EXISTS (SELECT 1 FROM app.aml_hold_lifts l WHERE l.hold_id = h.id)
  )
$$;
REVOKE ALL ON FUNCTION app.has_active_aml_hold(uuid) FROM PUBLIC;

CREATE FUNCTION app.grant_aml_start_exception(target_id uuid, target_assessment uuid, selected_actions text[],
  selected_expires date, selected_context text, selected_key smallint, selected_nonce bytea,
  selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
DECLARE today date := app.london_today();
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  assessment := app.assert_current_aml_assessment(target_assessment, actor_id);
  IF assessment.prepared_by = actor_id THEN
    RAISE EXCEPTION 'the preparer cannot grant an exception on their own assessment' USING ERRCODE = 'check_violation';
  END IF;
  IF assessment.rating = 'high' OR assessment.pep OR assessment.high_risk_country OR assessment.unusual_transactions THEN
    RAISE EXCEPTION 'an early start needs recorded low-risk grounds' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_expires <= today OR selected_expires > today + 30 THEN
    RAISE EXCEPTION 'an early start lasts at most 30 days' USING ERRCODE = 'check_violation';
  END IF;
  IF app.has_active_aml_hold(assessment.matter_id) THEN
    RAISE EXCEPTION 'a held matter cannot start early' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_start_exceptions(id, matter_id, assessment_id, permitted_actions, expires_on,
    encryption_context, key_version, nonce, ciphertext, auth_tag, granted_by)
    VALUES (target_id, assessment.matter_id, target_assessment, selected_actions, selected_expires,
      selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.grant_aml_start_exception(uuid, uuid, text[], date, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.grant_aml_start_exception(uuid, uuid, text[], date, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.approve_aml_start_exception(target_exception uuid, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE exception_row app.aml_start_exceptions%ROWTYPE;
DECLARE preparer uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'partner');
  SELECT * INTO exception_row FROM app.aml_start_exceptions WHERE id = target_exception FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT prepared_by INTO preparer FROM app.aml_risk_assessments WHERE id = exception_row.assessment_id;
  IF actor_id IN (exception_row.granted_by, preparer) THEN
    RAISE EXCEPTION 'the exception needs a different partner' USING ERRCODE = 'check_violation';
  END IF;
  IF exception_row.expires_on < app.london_today() THEN
    RAISE EXCEPTION 'the exception has expired' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_exception_approvals(exception_id, approved_by) VALUES (target_exception, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.approve_aml_start_exception(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_aml_start_exception(uuid, uuid) TO pms_app;

-- 15c-3's gate, now `held` first while any hold on the matter or its client is active.
CREATE OR REPLACE FUNCTION app.aml_gate(target_matter uuid, OUT state text, OUT due_since date,
  OUT work_allowed_until date, OUT clearance_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE today date := app.london_today();
DECLARE clearance app.aml_clearances%ROWTYPE;
DECLARE assessment app.aml_risk_assessments%ROWTYPE;
DECLARE candidates date[] := '{}';
BEGIN
  IF app.has_active_aml_hold(target_matter) THEN
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
    -- The last day non-money work may continue; with no grace that is the day before it fell due.
    work_allowed_until := due_since + assessment.review_grace_days - 1;
  END IF;
END;
$$;

-- Refuses gated work with one generic reason, so callers cannot tell a hold from
-- missing CDD or an overdue review. `money` is never allowed while review is due.
CREATE FUNCTION app.assert_aml_gate(target_matter uuid, selected_action text) RETURNS void
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
REVOKE ALL ON FUNCTION app.assert_aml_gate(uuid, text) FROM PUBLIC;

CREATE FUNCTION app.enforce_aml_gate() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'time_entries' THEN
      PERFORM app.assert_aml_gate(NEW.matter_id, 'time');
    WHEN 'bill_drafts', 'issued_bills' THEN
      PERFORM app.assert_aml_gate(NEW.matter_id, 'billing');
    WHEN 'documents' THEN
      PERFORM app.assert_aml_gate(NEW.matter_id, 'documents');
    WHEN 'document_versions' THEN
      SELECT matter_id INTO target FROM app.documents WHERE id = NEW.document_id;
      PERFORM app.assert_aml_gate(target, 'documents');
    WHEN 'client_payment_requests' THEN
      PERFORM app.assert_aml_gate(NEW.matter_id, 'money');
    WHEN 'client_payment_events' THEN
      -- Releasing money is gated; recording what the bank already did is not.
      IF NEW.kind = 'approved' THEN
        SELECT matter_id INTO target FROM app.client_payment_requests WHERE id = NEW.payment_request_id;
        PERFORM app.assert_aml_gate(target, 'money');
      END IF;
    WHEN 'finance_transactions' THEN
      -- Bank-confirmed receipts stay recordable; moving money between ledgers is gated.
      IF NEW.kind IN ('client_allocation', 'business_allocation') THEN
        PERFORM app.assert_aml_gate(NEW.matter_id, 'money');
        IF NEW.related_matter_id IS NOT NULL THEN PERFORM app.assert_aml_gate(NEW.related_matter_id, 'money'); END IF;
      END IF;
  END CASE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_aml_gate() FROM PUBLIC;

-- Named to run after each table's existing checks, so their specific messages win.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['time_entries', 'bill_drafts', 'issued_bills', 'documents', 'document_versions',
    'client_payment_requests', 'client_payment_events', 'finance_transactions'] LOOP
    EXECUTE format('CREATE TRIGGER zz_aml_gate BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.enforce_aml_gate()', table_name);
  END LOOP;
END $$;

-- Matters that need Compliance attention: pending, held or due for review, or
-- with a review date in the next 30 days. Closed matters are left out.
CREATE FUNCTION app.aml_review_queue(max_rows integer)
  RETURNS TABLE (matter_id uuid, state text, due_since date, work_allowed_until date, review_due_on date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, g.state, g.due_since, g.work_allowed_until, latest.review_due_on
  FROM app.matters m
  CROSS JOIN LATERAL app.aml_gate(m.id) g
  LEFT JOIN LATERAL (SELECT review_due_on FROM app.aml_risk_assessments WHERE matter_id = m.id
    ORDER BY version DESC LIMIT 1) latest ON true
  WHERE m.status <> 'closed'
    AND (g.state <> 'cleared' OR latest.review_due_on <= app.london_today() + 30)
  ORDER BY (g.state = 'held') DESC, coalesce(g.due_since, latest.review_due_on) NULLS LAST, m.id
  LIMIT least(greatest(max_rows, 1), 200)
$$;
REVOKE ALL ON FUNCTION app.aml_review_queue(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_review_queue(integer) TO pms_app;
