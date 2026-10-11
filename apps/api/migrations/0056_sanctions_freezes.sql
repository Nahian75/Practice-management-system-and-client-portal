-- Compliance / AML step 15d-3: confirmed designations freeze funds and work unless a
-- recorded licence permits the action; Accounts sees only the operational outcome.

CREATE TABLE app.aml_frozen_funds (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id               uuid        NOT NULL REFERENCES app.clients(id),
  matter_id               uuid        NOT NULL REFERENCES app.matters(id),
  amount_pence            bigint      NOT NULL,
  reason                  text        NOT NULL,
  finance_transaction_id  uuid        UNIQUE REFERENCES app.finance_transactions(id),
  frozen_at               timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_frozen_funds_amount_valid CHECK (amount_pence > 0),
  CONSTRAINT aml_frozen_funds_reason_valid CHECK (
    (reason = 'balance_at_confirmation' AND finance_transaction_id IS NULL)
    OR (reason = 'receipt' AND finance_transaction_id IS NOT NULL)
  )
);
CREATE INDEX aml_frozen_funds_client_idx ON app.aml_frozen_funds (client_id, frozen_at DESC);

-- Sorted, distinct actions a licence can permit.
CREATE FUNCTION app.is_licence_actions(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT cardinality(value) BETWEEN 1 AND 4 AND value <@ ARRAY['billing', 'documents', 'money', 'time']
    AND value = ARRAY(SELECT DISTINCT a COLLATE "C" FROM unnest(value) a ORDER BY 1)
$$;
REVOKE ALL ON FUNCTION app.is_licence_actions(text[]) FROM PUBLIC;

CREATE TABLE app.aml_sanctions_licences (
  id                  uuid        PRIMARY KEY,
  client_id           uuid        NOT NULL REFERENCES app.clients(id),
  authority           text        NOT NULL,
  licence_kind        text        NOT NULL,
  reference           text        NOT NULL,
  permitted_actions   text[]      NOT NULL,
  money_limit_pence   bigint,
  effective_from      date        NOT NULL,
  expires_on          date        NOT NULL,
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_sanctions_licences_authority_valid CHECK (authority IN ('ofsi', 'otsi', 'other')),
  CONSTRAINT aml_sanctions_licences_kind_valid CHECK (licence_kind IN ('specific', 'general')),
  CONSTRAINT aml_sanctions_licences_reference_safe CHECK (app.is_safe_text(reference) AND length(reference) BETWEEN 1 AND 100),
  CONSTRAINT aml_sanctions_licences_actions_valid CHECK (app.is_licence_actions(permitted_actions)),
  -- Money is only ever licensed up to a stated amount.
  CONSTRAINT aml_sanctions_licences_money_limit CHECK (
    ('money' = ANY (permitted_actions)) = (money_limit_pence IS NOT NULL)
    AND (money_limit_pence IS NULL OR money_limit_pence BETWEEN 1 AND 100000000000)
  ),
  CONSTRAINT aml_sanctions_licences_dates_valid CHECK (effective_from >= DATE '1900-01-01' AND expires_on >= effective_from),
  CONSTRAINT aml_sanctions_licences_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_sanctions_licences_context_valid CHECK (encryption_context = 'aml-licence:' || id::text)
);
CREATE INDEX aml_sanctions_licences_client_idx ON app.aml_sanctions_licences (client_id, expires_on DESC);

CREATE TABLE app.aml_licence_revocations (
  id                  uuid        PRIMARY KEY,
  licence_id          uuid        NOT NULL UNIQUE REFERENCES app.aml_sanctions_licences(id),
  encryption_context  text        NOT NULL UNIQUE,
  key_version         smallint    NOT NULL,
  nonce               bytea       NOT NULL,
  ciphertext          bytea       NOT NULL,
  auth_tag            bytea       NOT NULL,
  revoked_by          uuid        NOT NULL REFERENCES app.accounts(id),
  revoked_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_licence_revocations_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_licence_revocations_context_valid CHECK (encryption_context = 'aml-licence-revocation:' || id::text)
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_frozen_funds, app.aml_sanctions_licences,
  app.aml_licence_revocations FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_frozen_funds', 'aml_sanctions_licences', 'aml_licence_revocations'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- Money a licence has already been used for: payment requests not refused or cancelled,
-- and ledger allocations, on the client's matters since the licence was recorded.
CREATE FUNCTION app.aml_licence_money_used(target_licence uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT sum(r.amount_pence) FROM app.client_payment_requests r
      WHERE r.client_id = l.client_id AND r.requested_at >= l.recorded_at
        AND app.client_payment_state(r.id) NOT IN ('rejected', 'cancelled', 'bank_rejected')), 0)
    + coalesce((SELECT sum(t.amount_pence) FROM app.finance_transactions t
      WHERE t.client_id = l.client_id AND t.posted_at >= l.recorded_at
        AND t.kind IN ('client_allocation', 'business_allocation')), 0)
  FROM app.aml_sanctions_licences l WHERE l.id = target_licence
$$;
REVOKE ALL ON FUNCTION app.aml_licence_money_used(uuid) FROM PUBLIC;

-- The live licence, if any, that permits this action for a confirmed client today,
-- with `amount` more money still inside its limit.
CREATE FUNCTION app.aml_permitting_licence(target_client uuid, selected_action text, amount bigint) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.id FROM app.aml_sanctions_licences l
  WHERE l.client_id = target_client AND selected_action = ANY (l.permitted_actions)
    AND l.effective_from <= app.london_today() AND l.expires_on >= app.london_today()
    AND NOT EXISTS (SELECT 1 FROM app.aml_licence_revocations v WHERE v.licence_id = l.id)
    AND (selected_action <> 'money' OR app.aml_licence_money_used(l.id) + amount <= l.money_limit_pence)
  ORDER BY l.expires_on DESC, l.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.aml_permitting_licence(uuid, text, bigint) FROM PUBLIC;

CREATE FUNCTION app.record_aml_licence(target_id uuid, target_client uuid, selected_authority text, selected_kind text,
  selected_reference text, selected_actions text[], selected_limit bigint, selected_from date, selected_expires date,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM 1 FROM app.clients WHERE id = target_client FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(target_client));
  IF app.aml_sanctions_state(target_client) <> 'confirmed' THEN
    RAISE EXCEPTION 'a licence is recorded only for a confirmed designation' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_sanctions_licences(id, client_id, authority, licence_kind, reference, permitted_actions,
    money_limit_pence, effective_from, expires_on, encryption_context, key_version, nonce, ciphertext, auth_tag, recorded_by)
  VALUES (target_id, target_client, selected_authority, selected_kind, selected_reference, selected_actions,
    selected_limit, selected_from, selected_expires, selected_context, selected_key, selected_nonce, selected_ciphertext,
    selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_licence(uuid, uuid, text, text, text, text[], bigint, date, date, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_licence(uuid, uuid, text, text, text, text[], bigint, date, date, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.revoke_aml_licence(target_id uuid, target_licence uuid, selected_context text, selected_key smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE licence_client uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT client_id INTO licence_client FROM app.aml_sanctions_licences WHERE id = target_licence;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(licence_client));
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_licence_revocations(id, licence_id, encryption_context, key_version, nonce, ciphertext, auth_tag, revoked_by)
    VALUES (target_id, target_licence, selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.revoke_aml_licence(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_aml_licence(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

-- Records each matter's positive client-ledger balance as frozen.
CREATE FUNCTION app.freeze_aml_client_balances(target_client uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_frozen_funds(client_id, matter_id, amount_pence, reason)
    SELECT target_client, p.matter_id, sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END),
      'balance_at_confirmation'
    FROM app.finance_postings p WHERE p.account = 'client_ledger' AND p.client_id = target_client
    GROUP BY p.matter_id
    HAVING sum(CASE p.direction WHEN 'credit' THEN p.amount_pence ELSE -p.amount_pence END) > 0;
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.freeze_aml_client_balances(uuid) FROM PUBLIC;

-- 15d-2's resolution, now also freezing the client's balances when a match is confirmed.
CREATE OR REPLACE FUNCTION app.resolve_aml_candidate(target_id uuid, target_candidate uuid, selected_outcome text,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_client uuid;
DECLARE already_confirmed boolean;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT s.client_id INTO target_client FROM app.aml_screening_candidates c
    JOIN app.aml_screenings s ON s.id = c.screening_id WHERE c.id = target_candidate;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(target_client));
  already_confirmed := app.aml_sanctions_state(target_client) = 'confirmed';
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_candidate_resolutions(id, candidate_id, outcome, encryption_context, key_version, nonce, ciphertext, auth_tag, resolved_by)
    VALUES (target_id, target_candidate, selected_outcome, selected_context, selected_key, selected_nonce, selected_ciphertext,
      selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
  IF selected_outcome = 'confirmed' AND NOT already_confirmed THEN
    PERFORM app.freeze_aml_client_balances(target_client);
  END IF;
END;
$$;

-- A bank-confirmed receipt for a matching client is still recorded, and frozen at once.
CREATE FUNCTION app.freeze_aml_receipt() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('client_receipt', 'business_receipt')
    AND app.aml_sanctions_state(NEW.client_id) IN ('possible_match', 'confirmed') THEN
    PERFORM set_config('app.aml_risk_write', '1', true);
    INSERT INTO app.aml_frozen_funds(client_id, matter_id, amount_pence, reason, finance_transaction_id)
      VALUES (NEW.client_id, NEW.matter_id, NEW.amount_pence, 'receipt', NEW.id);
    PERFORM set_config('app.aml_risk_write', '0', true);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.freeze_aml_receipt() FROM PUBLIC;
CREATE TRIGGER aml_freeze_receipt AFTER INSERT ON app.finance_transactions
  FOR EACH ROW EXECUTE FUNCTION app.freeze_aml_receipt();

-- The gate without sanctions: holds, clearance and review. Identical to 15d-2's gate
-- after its sanctions check, so a licence can lift a designation without lifting a hold.
CREATE FUNCTION app.aml_gate_core(target_matter uuid, OUT state text, OUT due_since date,
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
    work_allowed_until := due_since + assessment.review_grace_days - 1;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.aml_gate_core(uuid) FROM PUBLIC;

-- The gate as shown: a possible or confirmed match holds the matter, otherwise the core gate.
CREATE OR REPLACE FUNCTION app.aml_gate(target_matter uuid, OUT state text, OUT due_since date,
  OUT work_allowed_until date, OUT clearance_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF app.aml_sanctions_state((SELECT client_id FROM app.matters WHERE id = target_matter)) IN ('possible_match', 'confirmed') THEN
    state := 'held';
    RETURN;
  END IF;
  SELECT g.state, g.due_since, g.work_allowed_until, g.clearance_id INTO state, due_since, work_allowed_until, clearance_id
    FROM app.aml_gate_core(target_matter) g;
END;
$$;

-- Enforcement with the amount of money involved. A confirmed designation refuses every
-- action unless a live licence permits it (money within the licence limit); the matter
-- must still pass its holds, clearance and review rules. Every refusal is the same.
CREATE FUNCTION app.assert_aml_gate_amount(target_matter uuid, selected_action text, amount bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE gate record;
DECLARE matter_client uuid;
DECLARE sanctions text;
DECLARE today date := app.london_today();
BEGIN
  SELECT client_id INTO matter_client FROM app.matters WHERE id = target_matter;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock_shared(app.aml_matter_lock_key(target_matter));
  PERFORM pg_advisory_xact_lock_shared(app.aml_client_lock_key(matter_client));
  sanctions := app.aml_sanctions_state(matter_client);
  IF sanctions = 'possible_match'
    OR (sanctions = 'confirmed' AND app.aml_permitting_licence(matter_client, selected_action, amount) IS NULL)
    OR (selected_action = 'money' AND sanctions NOT IN ('clear', 'confirmed')) THEN
    RAISE EXCEPTION 'compliance clearance is required for this action' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO gate FROM app.aml_gate_core(target_matter);
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
REVOKE ALL ON FUNCTION app.assert_aml_gate_amount(uuid, text, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.assert_aml_gate(target_matter uuid, selected_action text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.assert_aml_gate_amount(target_matter, selected_action, 0)
$$;

-- 15c-4's triggers, now passing the money involved so a licence limit can be enforced.
CREATE OR REPLACE FUNCTION app.enforce_aml_gate() RETURNS trigger
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
      PERFORM app.assert_aml_gate_amount(NEW.matter_id, 'money', NEW.amount_pence);
    WHEN 'client_payment_events' THEN
      -- Releasing money is gated; recording what the bank already did is not. The request
      -- already counted towards any licence limit, so approval adds nothing to it.
      IF NEW.kind = 'approved' THEN
        SELECT matter_id INTO target FROM app.client_payment_requests WHERE id = NEW.payment_request_id;
        PERFORM app.assert_aml_gate(target, 'money');
      END IF;
    WHEN 'finance_transactions' THEN
      IF NEW.kind IN ('client_allocation', 'business_allocation') THEN
        PERFORM app.assert_aml_gate_amount(NEW.matter_id, 'money', NEW.amount_pence);
        IF NEW.related_matter_id IS NOT NULL THEN PERFORM app.assert_aml_gate_amount(NEW.related_matter_id, 'money', NEW.amount_pence); END IF;
      END IF;
  END CASE;
  RETURN NEW;
END;
$$;

-- What Accounts may know: allowed, frozen (a confirmed designation without a licence for
-- money) or contact Compliance, plus the limits of a licence that permits money.
CREATE FUNCTION app.aml_money_status(target_matter uuid, OUT status text, OUT licence_id uuid,
  OUT limit_pence bigint, OUT used_pence bigint, OUT licence_expires_on date)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE matter_client uuid;
BEGIN
  SELECT client_id INTO matter_client FROM app.matters WHERE id = target_matter;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  BEGIN
    PERFORM app.assert_aml_gate(target_matter, 'money');
    status := 'allowed';
  EXCEPTION WHEN check_violation THEN
    status := CASE WHEN app.aml_sanctions_state(matter_client) = 'confirmed' THEN 'frozen' ELSE 'contact_compliance' END;
  END;
  IF app.aml_sanctions_state(matter_client) = 'confirmed' THEN
    SELECT l.id, l.money_limit_pence, app.aml_licence_money_used(l.id), l.expires_on
      INTO licence_id, limit_pence, used_pence, licence_expires_on
      FROM app.aml_sanctions_licences l
      WHERE l.id = app.aml_permitting_licence(matter_client, 'money', 0);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.aml_money_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_money_status(uuid) TO pms_app;
