-- Compliance / AML step 15f: relationship-end retention schedules, permanent
-- legal-hold events, controlled disposal and separately authorised fixed exports.

CREATE TABLE app.aml_retention_schedules (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL UNIQUE REFERENCES app.clients(id),
  relationship_ended_on date NOT NULL,
  retention_years smallint NOT NULL,
  dispose_after date NOT NULL,
  governing_rule text NOT NULL,
  evidence_context text NOT NULL UNIQUE,
  evidence_key_version smallint NOT NULL,
  evidence_nonce bytea NOT NULL,
  evidence_ciphertext bytea NOT NULL,
  evidence_auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_retention_years_valid CHECK (retention_years = 5),
  CONSTRAINT aml_retention_dates_valid CHECK (
    relationship_ended_on BETWEEN DATE '1900-01-01' AND app.london_today()
    AND dispose_after = (relationship_ended_on + make_interval(years => retention_years))::date
  ),
  CONSTRAINT aml_retention_rule_safe CHECK (app.is_safe_text(governing_rule) AND length(governing_rule) BETWEEN 10 AND 500),
  CONSTRAINT aml_retention_evidence_crypto CHECK (evidence_key_version > 0 AND octet_length(evidence_nonce) = 12
    AND octet_length(evidence_auth_tag) = 16 AND octet_length(evidence_ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_retention_evidence_context CHECK (evidence_context = 'aml-retention-schedule:' || id::text)
);
CREATE INDEX aml_retention_schedules_due_idx ON app.aml_retention_schedules (dispose_after, id);

CREATE TABLE app.aml_legal_hold_events (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES app.aml_retention_schedules(id),
  action text NOT NULL,
  review_on date,
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_legal_hold_action_valid CHECK (action IN ('imposed', 'reviewed', 'released')),
  CONSTRAINT aml_legal_hold_review_valid CHECK (
    (action IN ('imposed', 'reviewed') AND review_on IS NOT NULL)
    OR (action = 'released' AND review_on IS NULL)
  ),
  CONSTRAINT aml_legal_hold_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_legal_hold_context CHECK (encryption_context = 'aml-legal-hold:' || id::text)
);
CREATE INDEX aml_legal_hold_events_schedule_idx ON app.aml_legal_hold_events (schedule_id, recorded_at DESC, id DESC);

CREATE TABLE app.aml_exports (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  sha256 bytea NOT NULL,
  byte_size integer NOT NULL,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_exports_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 10000000),
  CONSTRAINT aml_exports_context CHECK (encryption_context = 'aml-export:' || id::text),
  CONSTRAINT aml_exports_hash CHECK (octet_length(sha256) = 32),
  CONSTRAINT aml_exports_size CHECK (byte_size BETWEEN 2 AND 10000000)
);
CREATE INDEX aml_exports_recent_idx ON app.aml_exports (id DESC);

CREATE TABLE app.aml_restricted_exports (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES app.aml_internal_reports(id),
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  sha256 bytea NOT NULL,
  byte_size integer NOT NULL,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_restricted_exports_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 10000000),
  CONSTRAINT aml_restricted_exports_context CHECK (encryption_context = 'suspicion-export:' || id::text),
  CONSTRAINT aml_restricted_exports_hash CHECK (octet_length(sha256) = 32),
  CONSTRAINT aml_restricted_exports_size CHECK (byte_size BETWEEN 2 AND 10000000)
);
CREATE INDEX aml_restricted_exports_report_idx ON app.aml_restricted_exports (report_id, id DESC);

CREATE FUNCTION app.is_safe_aml_storage_keys(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT value IS NOT NULL AND cardinality(value) <= 10000
    AND NOT EXISTS (SELECT 1 FROM unnest(value) key
      WHERE key IS NULL OR key !~ '^compliance(/restricted)?/[0-9a-f-]{36}$')
$$;
REVOKE ALL ON FUNCTION app.is_safe_aml_storage_keys(text[]) FROM PUBLIC;

CREATE TABLE app.aml_disposal_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL UNIQUE,
  client_id uuid NOT NULL,
  governing_rule text NOT NULL,
  state text NOT NULL,
  object_keys text[] NOT NULL,
  prepared_by uuid NOT NULL REFERENCES app.accounts(id),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_by uuid REFERENCES app.accounts(id),
  completed_at timestamptz,
  record_count integer,
  CONSTRAINT aml_disposal_runs_state CHECK (
    (state = 'prepared' AND completed_by IS NULL AND completed_at IS NULL AND record_count IS NULL)
    OR (state = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL
      AND record_count IS NOT NULL AND record_count >= 0 AND cardinality(object_keys) = 0)
  ),
  CONSTRAINT aml_disposal_runs_rule_safe CHECK (app.is_safe_text(governing_rule) AND length(governing_rule) BETWEEN 10 AND 500),
  CONSTRAINT aml_disposal_runs_keys_safe CHECK (app.is_safe_aml_storage_keys(object_keys))
);
CREATE INDEX aml_disposal_runs_recent_idx ON app.aml_disposal_runs (id DESC);

CREATE TABLE app.aml_disposed_records (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id uuid NOT NULL REFERENCES app.aml_disposal_runs(id),
  record_id uuid NOT NULL,
  record_kind text NOT NULL,
  governing_rule text NOT NULL,
  disposed_by uuid NOT NULL REFERENCES app.accounts(id),
  disposed_at timestamptz NOT NULL,
  UNIQUE (run_id, record_kind, record_id),
  CONSTRAINT aml_disposed_records_kind_safe CHECK (record_kind ~ '^aml_[a-z_]{2,80}$'),
  CONSTRAINT aml_disposed_records_rule_safe CHECK (app.is_safe_text(governing_rule) AND length(governing_rule) BETWEEN 10 AND 500)
);
CREATE INDEX aml_disposed_records_run_idx ON app.aml_disposed_records (run_id, id);

REVOKE ALL ON app.aml_retention_schedules, app.aml_legal_hold_events, app.aml_exports,
  app.aml_restricted_exports, app.aml_disposal_runs, app.aml_disposed_records FROM pms_app;

CREATE FUNCTION app.protect_aml_retention_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_retention_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'retention records change only through protected functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION app.protect_aml_retention_write() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_retention_schedules','aml_legal_hold_events','aml_exports',
    'aml_restricted_exports','aml_disposal_runs','aml_disposed_records'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_retention_write()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_retention_write()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- Existing immutable AML rows permit erasure only while the security-definer
-- disposal function below is executing. The application role still has no
-- DELETE grant and setting the flag cannot grant it one.
CREATE OR REPLACE FUNCTION app.refuse_aml_foundation_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_disposal', true) = '1' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'published compliance records are immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION app.refuse_aml_cdd_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_disposal', true) = '1' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'CDD history is immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION app.protect_aml_cdd_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_disposal', true) = '1' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' OR OLD.status <> 'draft'
     OR NEW.id <> OLD.id OR NEW.client_id <> OLD.client_id OR NEW.version <> OLD.version
     OR NEW.intended_relationship <> OLD.intended_relationship OR NEW.reason <> OLD.reason
     OR NEW.prepared_by <> OLD.prepared_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'CDD cases change only through protected finalization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('app.aml_cdd_submit', true) = '1' THEN
    IF NEW.status <> 'submitted' OR NEW.client_snapshot IS NULL OR NEW.submitted_at IS NULL
       OR NEW.abandoned_by IS NOT NULL OR NEW.abandoned_at IS NOT NULL OR NEW.abandonment_reason IS NOT NULL THEN
      RAISE EXCEPTION 'invalid protected CDD submission' USING ERRCODE='insufficient_privilege'; END IF;
  ELSIF current_setting('app.aml_cdd_abandon', true) = '1' THEN
    IF NEW.status <> 'abandoned' OR NEW.client_snapshot IS NOT NULL OR NEW.submitted_at IS NOT NULL
       OR NEW.abandoned_by IS NULL OR NEW.abandoned_at IS NULL OR NEW.abandonment_reason IS NULL THEN
      RAISE EXCEPTION 'invalid protected CDD abandonment' USING ERRCODE='insufficient_privilege'; END IF;
  ELSE
    RAISE EXCEPTION 'CDD cases change only through protected finalization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.record_aml_retention_schedule(
  schedule_id uuid, target_client uuid, ended_on date, years_to_keep smallint, rule text,
  evidence_context text, evidence_key_version smallint, evidence_nonce bytea,
  evidence_ciphertext bytea, evidence_auth_tag bytea, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE client_status text;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(target_client));
  SELECT status INTO client_status FROM app.clients WHERE id = target_client FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF EXISTS (SELECT 1 FROM app.matters WHERE client_id = target_client AND status <> 'closed' FOR SHARE) THEN
    RAISE EXCEPTION 'all client matters must be closed first' USING ERRCODE = 'check_violation';
  END IF;
  IF client_status = 'active' THEN UPDATE app.clients SET status='archived' WHERE id=target_client; END IF;
  PERFORM set_config('app.aml_retention_write', '1', true);
  INSERT INTO app.aml_retention_schedules(id, client_id, relationship_ended_on, retention_years,
    dispose_after, governing_rule, evidence_context, evidence_key_version, evidence_nonce,
    evidence_ciphertext, evidence_auth_tag, recorded_by)
  VALUES (schedule_id, target_client, ended_on, years_to_keep,
    (ended_on + make_interval(years => years_to_keep))::date, rule, evidence_context,
    evidence_key_version, evidence_nonce, evidence_ciphertext, evidence_auth_tag, actor_id);
  RETURN schedule_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_retention_schedule(uuid,uuid,date,smallint,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_retention_schedule(uuid,uuid,date,smallint,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_aml_legal_hold_event(
  event_id uuid, target_schedule uuid, event_action text, next_review date,
  encryption_context text, key_version smallint, nonce bytea, ciphertext bytea, auth_tag bytea,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_action text;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM 1 FROM app.aml_retention_schedules WHERE id = target_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT action INTO current_action FROM app.aml_legal_hold_events
    WHERE schedule_id = target_schedule ORDER BY recorded_at DESC, id DESC LIMIT 1;
  IF event_action = 'imposed' AND current_action IS NOT NULL AND current_action <> 'released' THEN
    RAISE EXCEPTION 'a legal hold is already active' USING ERRCODE = 'check_violation';
  ELSIF event_action IN ('reviewed','released') AND current_action IS DISTINCT FROM 'imposed'
      AND current_action IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'there is no active legal hold' USING ERRCODE = 'check_violation';
  END IF;
  IF event_action IN ('imposed','reviewed') AND next_review < app.london_today() THEN
    RAISE EXCEPTION 'the legal hold review cannot already be overdue' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_retention_write', '1', true);
  INSERT INTO app.aml_legal_hold_events(id,schedule_id,action,review_on,encryption_context,key_version,
    nonce,ciphertext,auth_tag,recorded_by)
  VALUES(event_id,target_schedule,event_action,next_review,encryption_context,key_version,nonce,ciphertext,auth_tag,actor_id);
  RETURN event_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_legal_hold_event(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_legal_hold_event(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.list_aml_retention_schedules(actor_id uuid)
  RETURNS TABLE(id uuid, client_id uuid, relationship_ended_on date, retention_years smallint,
    dispose_after date, governing_rule text, hold_action text, hold_review_on date,
    recorded_by uuid, recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  RETURN QUERY SELECT s.id,s.client_id,s.relationship_ended_on,s.retention_years,s.dispose_after,s.governing_rule,
    h.action,h.review_on,s.recorded_by,s.recorded_at
  FROM app.aml_retention_schedules s
  LEFT JOIN LATERAL (SELECT e.action,e.review_on FROM app.aml_legal_hold_events e
    WHERE e.schedule_id=s.id ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1) h ON true
  ORDER BY s.dispose_after,s.id LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_aml_retention_schedules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_retention_schedules(uuid) TO pms_app;

CREATE FUNCTION app.read_aml_retention_schedule(target_schedule uuid,actor_id uuid)
  RETURNS SETOF app.aml_retention_schedules LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  RETURN QUERY SELECT * FROM app.aml_retention_schedules WHERE id=target_schedule;
END;
$$;
REVOKE ALL ON FUNCTION app.read_aml_retention_schedule(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_retention_schedule(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_legal_hold_events(target_schedule uuid,actor_id uuid)
  RETURNS SETOF app.aml_legal_hold_events LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  PERFORM 1 FROM app.aml_retention_schedules WHERE id=target_schedule;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  RETURN QUERY SELECT * FROM app.aml_legal_hold_events WHERE schedule_id=target_schedule ORDER BY recorded_at,id;
END;
$$;
REVOKE ALL ON FUNCTION app.read_aml_legal_hold_events(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_legal_hold_events(uuid,uuid) TO pms_app;

CREATE FUNCTION app.aml_compliance_access(actor_id uuid)
  RETURNS TABLE(can_restricted boolean, attention_count integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  RETURN QUERY SELECT
    EXISTS (SELECT 1 FROM app.aml_officer_appointments o
      WHERE o.account_id=actor_id AND o.kind='nominated_officer' AND o.ended_at IS NULL),
    LEAST(999,
      (SELECT count(*)::integer FROM app.aml_screening_candidates c
        LEFT JOIN app.aml_candidate_resolutions r ON r.candidate_id=c.id WHERE r.id IS NULL)
      + (SELECT count(*)::integer FROM app.aml_holds h LEFT JOIN app.aml_hold_lifts l ON l.hold_id=h.id
        WHERE l.id IS NULL AND NOT EXISTS (SELECT 1 FROM app.aml_restricted_hold_links x WHERE x.hold_id=h.id))
      + (SELECT count(*)::integer FROM app.aml_retention_schedules s WHERE s.dispose_after <= app.london_today()
        AND COALESCE((SELECT e.action FROM app.aml_legal_hold_events e WHERE e.schedule_id=s.id
          ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),'released')='released')
      + CASE WHEN app.aml_sanctions_checked_within(interval '48 hours') THEN 0 ELSE 1 END
    );
END;
$$;
REVOKE ALL ON FUNCTION app.aml_compliance_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_compliance_access(uuid) TO pms_app;

CREATE FUNCTION app.list_aml_client_choices(actor_id uuid)
  RETURNS TABLE(id uuid, reference text, kind text, name text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  RETURN QUERY SELECT c.id,c.reference,c.kind,
    CASE WHEN c.kind='individual' THEN concat_ws(' ',i.given_names,i.family_name) ELSE o.legal_name END
  FROM app.clients c LEFT JOIN app.client_individuals i ON i.client_id=c.id
    LEFT JOIN app.client_organisations o ON o.client_id=c.id
  ORDER BY c.reference DESC LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_aml_client_choices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_client_choices(uuid) TO pms_app;

CREATE FUNCTION app.prepare_aml_disposal(run_id uuid, target_schedule uuid, actor_id uuid)
  RETURNS TABLE(id uuid, object_keys text[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE schedule app.aml_retention_schedules; keys text[];
DECLARE client_status text;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT * INTO schedule FROM app.aml_retention_schedules WHERE aml_retention_schedules.id=target_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(schedule.client_id));
  IF schedule.dispose_after > app.london_today() THEN
    RAISE EXCEPTION 'the retention period has not ended' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.status INTO client_status FROM app.clients c WHERE c.id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.matters m WHERE m.client_id=schedule.client_id FOR UPDATE;
  IF client_status <> 'archived'
    OR EXISTS (SELECT 1 FROM app.matters m WHERE m.client_id=schedule.client_id AND m.status <> 'closed') THEN
    RAISE EXCEPTION 'the client relationship is still active' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE((SELECT e.action FROM app.aml_legal_hold_events e WHERE e.schedule_id=schedule.id
    ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),'released') <> 'released' THEN
    RAISE EXCEPTION 'an active legal hold prevents disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_holds h LEFT JOIN app.aml_hold_lifts l ON l.hold_id=h.id
    WHERE h.client_id=schedule.client_id AND l.id IS NULL) THEN
    RAISE EXCEPTION 'an operational compliance hold prevents disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_internal_reports r WHERE r.client_id=schedule.client_id) THEN
    PERFORM app.assert_aml_nominated_officer(actor_id);
  END IF;
  -- The application keeps this transaction open through object deletion and
  -- finalization. Lock every parent through which new client AML rows can be
  -- attached, so no record or object can appear after the key snapshot.
  PERFORM 1 FROM app.aml_cdd_cases c WHERE c.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_risk_assessments a WHERE a.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_measures m JOIN app.aml_risk_assessments a ON a.id=m.assessment_id
    WHERE a.client_id=schedule.client_id FOR UPDATE OF m;
  PERFORM 1 FROM app.aml_clearances c JOIN app.matters m ON m.id=c.matter_id
    WHERE m.client_id=schedule.client_id FOR UPDATE OF c;
  PERFORM 1 FROM app.aml_holds h WHERE h.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_screenings s WHERE s.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_sanctions_licences l WHERE l.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_internal_reports r WHERE r.client_id=schedule.client_id FOR UPDATE;
  PERFORM 1 FROM app.aml_external_reports e JOIN app.aml_internal_reports r ON r.id=e.internal_report_id
    WHERE r.client_id=schedule.client_id FOR UPDATE OF e;
  SELECT COALESCE(array_agg(storage_key ORDER BY storage_key),'{}'::text[]) INTO keys FROM (
    SELECT e.storage_key FROM app.aml_cdd_evidence e JOIN app.aml_cdd_cases c ON c.id=e.cdd_case_id
      WHERE c.client_id=schedule.client_id
    UNION ALL
    SELECT a.storage_key FROM app.aml_internal_report_attachments a JOIN app.aml_internal_reports r ON r.id=a.report_id
      WHERE r.client_id=schedule.client_id
  ) stored;
  PERFORM set_config('app.aml_retention_write', '1', true);
  INSERT INTO app.aml_disposal_runs(id,schedule_id,client_id,governing_rule,state,object_keys,prepared_by)
    VALUES(run_id,schedule.id,schedule.client_id,schedule.governing_rule,'prepared',keys,actor_id)
    ON CONFLICT (schedule_id) DO NOTHING;
  RETURN QUERY SELECT r.id,r.object_keys FROM app.aml_disposal_runs r WHERE r.schedule_id=schedule.id AND r.state='prepared';
END;
$$;
REVOKE ALL ON FUNCTION app.prepare_aml_disposal(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_aml_disposal(uuid,uuid,uuid) TO pms_app;

CREATE FUNCTION app.finalize_aml_disposal(target_run uuid, actor_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE run app.aml_disposal_runs; schedule app.aml_retention_schedules; disposed_at timestamptz := clock_timestamp(); total integer;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT * INTO run FROM app.aml_disposal_runs WHERE id=target_run FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF run.state='completed' THEN RETURN run.record_count; END IF;
  SELECT * INTO schedule FROM app.aml_retention_schedules WHERE id=run.schedule_id FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(app.aml_client_lock_key(schedule.client_id));
  IF schedule.dispose_after > app.london_today()
    OR EXISTS (SELECT 1 FROM app.clients WHERE id=schedule.client_id AND status <> 'archived')
    OR EXISTS (SELECT 1 FROM app.matters WHERE client_id=schedule.client_id AND status <> 'closed') THEN
    RAISE EXCEPTION 'the client is not eligible for disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE((SELECT e.action FROM app.aml_legal_hold_events e WHERE e.schedule_id=schedule.id
    ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),'released') <> 'released' THEN
    RAISE EXCEPTION 'an active legal hold prevents disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_holds h LEFT JOIN app.aml_hold_lifts l ON l.hold_id=h.id
    WHERE h.client_id=schedule.client_id AND l.id IS NULL) THEN
    RAISE EXCEPTION 'an operational compliance hold prevents disposal' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.aml_internal_reports WHERE client_id=schedule.client_id) THEN
    PERFORM app.assert_aml_nominated_officer(actor_id);
  END IF;

  PERFORM set_config('app.aml_retention_write', '1', true);
  PERFORM set_config('app.aml_disposal', '1', true);

  INSERT INTO app.aml_disposed_records(run_id,record_id,record_kind,governing_rule,disposed_by,disposed_at)
  SELECT run.id, records.id, records.kind, schedule.governing_rule, actor_id, disposed_at FROM (
    SELECT schedule.id,'aml_retention_schedule' kind
    UNION ALL SELECT e.id,'aml_legal_hold_event' FROM app.aml_legal_hold_events e WHERE e.schedule_id=schedule.id
    UNION ALL SELECT id,'aml_internal_report' FROM app.aml_internal_reports WHERE client_id=schedule.client_id
    UNION ALL SELECT a.id,'aml_internal_report_attachment' FROM app.aml_internal_report_attachments a JOIN app.aml_internal_reports r ON r.id=a.report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT d.id,'aml_internal_report_decision' FROM app.aml_internal_report_decisions d JOIN app.aml_internal_reports r ON r.id=d.report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT e.id,'aml_external_report' FROM app.aml_external_reports e JOIN app.aml_internal_reports r ON r.id=e.internal_report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT e.id,'aml_daml_datf_event' FROM app.aml_daml_datf_events e JOIN app.aml_external_reports x ON x.id=e.external_report_id JOIN app.aml_internal_reports r ON r.id=x.internal_report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT a.id,'aml_restricted_access' FROM app.aml_restricted_access_log a JOIN app.aml_internal_reports r ON r.id=a.report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT l.report_id,'aml_restricted_hold_link' FROM app.aml_restricted_hold_links l JOIN app.aml_internal_reports r ON r.id=l.report_id WHERE r.client_id=schedule.client_id
    UNION ALL SELECT id,'aml_frozen_fund' FROM app.aml_frozen_funds WHERE client_id=schedule.client_id
    UNION ALL SELECT id,'aml_sanctions_licence' FROM app.aml_sanctions_licences WHERE client_id=schedule.client_id
    UNION ALL SELECT r.id,'aml_licence_revocation' FROM app.aml_licence_revocations r JOIN app.aml_sanctions_licences l ON l.id=r.licence_id WHERE l.client_id=schedule.client_id
    UNION ALL SELECT id,'aml_screening' FROM app.aml_screenings WHERE client_id=schedule.client_id
    UNION ALL SELECT c.id,'aml_screening_candidate' FROM app.aml_screening_candidates c JOIN app.aml_screenings s ON s.id=c.screening_id WHERE s.client_id=schedule.client_id
    UNION ALL SELECT r.id,'aml_candidate_resolution' FROM app.aml_candidate_resolutions r JOIN app.aml_screening_candidates c ON c.id=r.candidate_id JOIN app.aml_screenings s ON s.id=c.screening_id WHERE s.client_id=schedule.client_id
    UNION ALL SELECT id,'aml_hold' FROM app.aml_holds WHERE client_id=schedule.client_id
    UNION ALL SELECT l.id,'aml_hold_lift' FROM app.aml_hold_lifts l JOIN app.aml_holds h ON h.id=l.hold_id WHERE h.client_id=schedule.client_id
    UNION ALL SELECT e.id,'aml_start_exception' FROM app.aml_start_exceptions e JOIN app.matters m ON m.id=e.matter_id WHERE m.client_id=schedule.client_id
    UNION ALL SELECT p.id,'aml_exception_approval' FROM app.aml_exception_approvals p JOIN app.aml_start_exceptions e ON e.id=p.exception_id JOIN app.matters m ON m.id=e.matter_id WHERE m.client_id=schedule.client_id
    UNION ALL SELECT c.id,'aml_clearance' FROM app.aml_clearances c JOIN app.matters m ON m.id=c.matter_id WHERE m.client_id=schedule.client_id
    UNION ALL SELECT p.id,'aml_senior_approval' FROM app.aml_senior_approvals p JOIN app.aml_clearances c ON c.id=p.clearance_id JOIN app.matters m ON m.id=c.matter_id WHERE m.client_id=schedule.client_id
    UNION ALL SELECT s.id,'aml_source_conclusion' FROM app.aml_source_conclusions s JOIN app.aml_risk_assessments a ON a.id=s.assessment_id WHERE a.client_id=schedule.client_id
    UNION ALL SELECT m.id,'aml_measure' FROM app.aml_measures m JOIN app.aml_risk_assessments a ON a.id=m.assessment_id WHERE a.client_id=schedule.client_id
    UNION ALL SELECT r.id,'aml_measure_result' FROM app.aml_measure_results r JOIN app.aml_measures m ON m.id=r.measure_id JOIN app.aml_risk_assessments a ON a.id=m.assessment_id WHERE a.client_id=schedule.client_id
    UNION ALL SELECT id,'aml_risk_assessment' FROM app.aml_risk_assessments WHERE client_id=schedule.client_id
    UNION ALL SELECT id,'aml_cdd_case' FROM app.aml_cdd_cases WHERE client_id=schedule.client_id
    UNION ALL SELECT s.id,'aml_cdd_subject' FROM app.aml_cdd_subjects s JOIN app.aml_cdd_cases c ON c.id=s.cdd_case_id WHERE c.client_id=schedule.client_id
    UNION ALL SELECT e.id,'aml_cdd_evidence' FROM app.aml_cdd_evidence e JOIN app.aml_cdd_cases c ON c.id=e.cdd_case_id WHERE c.client_id=schedule.client_id
    UNION ALL SELECT o.id,'aml_cdd_ownership' FROM app.aml_cdd_ownership_controls o JOIN app.aml_cdd_cases c ON c.id=o.cdd_case_id WHERE c.client_id=schedule.client_id
    UNION ALL SELECT a.id,'aml_cdd_authority' FROM app.aml_cdd_authorities a JOIN app.aml_cdd_cases c ON c.id=a.cdd_case_id WHERE c.client_id=schedule.client_id
    UNION ALL SELECT v.id,'aml_cdd_verification' FROM app.aml_cdd_verifications v JOIN app.aml_cdd_cases c ON c.id=v.cdd_case_id WHERE c.client_id=schedule.client_id
    UNION ALL SELECT x.id,'aml_client_change' FROM app.aml_client_changes x WHERE x.client_id=schedule.client_id
    UNION ALL SELECT id,'aml_export' FROM app.aml_exports WHERE client_id=schedule.client_id
    UNION ALL SELECT e.id,'aml_restricted_export' FROM app.aml_restricted_exports e JOIN app.aml_internal_reports r ON r.id=e.report_id WHERE r.client_id=schedule.client_id
  ) records;
  GET DIAGNOSTICS total = ROW_COUNT;

  DELETE FROM app.aml_restricted_exports e USING app.aml_internal_reports r WHERE e.report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_restricted_access_log a USING app.aml_internal_reports r WHERE a.report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_daml_datf_events e USING app.aml_external_reports x,app.aml_internal_reports r WHERE e.external_report_id=x.id AND x.internal_report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_external_reports e USING app.aml_internal_reports r WHERE e.internal_report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_internal_report_decisions d USING app.aml_internal_reports r WHERE d.report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_internal_report_attachments a USING app.aml_internal_reports r WHERE a.report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_restricted_hold_links l USING app.aml_internal_reports r WHERE l.report_id=r.id AND r.client_id=schedule.client_id;
  DELETE FROM app.aml_internal_reports WHERE client_id=schedule.client_id;

  DELETE FROM app.aml_licence_revocations r USING app.aml_sanctions_licences l WHERE r.licence_id=l.id AND l.client_id=schedule.client_id;
  DELETE FROM app.aml_frozen_funds WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_sanctions_licences WHERE client_id=schedule.client_id;
  UPDATE app.aml_screening_candidates c SET carried_from=NULL FROM app.aml_screenings s
    WHERE c.screening_id=s.id AND s.client_id=schedule.client_id AND c.carried_from IS NOT NULL;
  DELETE FROM app.aml_candidate_resolutions r USING app.aml_screening_candidates c,app.aml_screenings s
    WHERE r.candidate_id=c.id AND c.screening_id=s.id AND s.client_id=schedule.client_id;
  DELETE FROM app.aml_screening_candidates c USING app.aml_screenings s WHERE c.screening_id=s.id AND s.client_id=schedule.client_id;
  DELETE FROM app.aml_screenings WHERE client_id=schedule.client_id;

  DELETE FROM app.aml_hold_lifts l USING app.aml_holds h WHERE l.hold_id=h.id AND h.client_id=schedule.client_id;
  DELETE FROM app.aml_holds WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_exception_approvals a USING app.aml_start_exceptions e,app.matters m
    WHERE a.exception_id=e.id AND e.matter_id=m.id AND m.client_id=schedule.client_id;
  DELETE FROM app.aml_start_exceptions e USING app.matters m WHERE e.matter_id=m.id AND m.client_id=schedule.client_id;
  DELETE FROM app.aml_senior_approvals s USING app.aml_clearances c,app.matters m
    WHERE s.clearance_id=c.id AND c.matter_id=m.id AND m.client_id=schedule.client_id;
  DELETE FROM app.aml_clearances c USING app.matters m WHERE c.matter_id=m.id AND m.client_id=schedule.client_id;
  DELETE FROM app.aml_measure_results r USING app.aml_measures m,app.aml_risk_assessments a
    WHERE r.measure_id=m.id AND m.assessment_id=a.id AND a.client_id=schedule.client_id;
  DELETE FROM app.aml_measures m USING app.aml_risk_assessments a WHERE m.assessment_id=a.id AND a.client_id=schedule.client_id;
  DELETE FROM app.aml_source_conclusions s USING app.aml_risk_assessments a WHERE s.assessment_id=a.id AND a.client_id=schedule.client_id;
  DELETE FROM app.aml_risk_assessment_controls c USING app.aml_risk_assessments a WHERE c.assessment_id=a.id AND a.client_id=schedule.client_id;
  DELETE FROM app.aml_risk_assessments WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_authorities a USING app.aml_cdd_cases c WHERE a.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_verifications v USING app.aml_cdd_cases c WHERE v.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_ownership_controls o USING app.aml_cdd_cases c WHERE o.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_evidence e USING app.aml_cdd_cases c WHERE e.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_subjects s USING app.aml_cdd_cases c WHERE s.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_case_controls x USING app.aml_cdd_cases c WHERE x.cdd_case_id=c.id AND c.client_id=schedule.client_id;
  DELETE FROM app.aml_cdd_cases WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_client_changes WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_exports WHERE client_id=schedule.client_id;
  DELETE FROM app.aml_legal_hold_events WHERE schedule_id=schedule.id;
  DELETE FROM app.aml_retention_schedules WHERE id=schedule.id;

  UPDATE app.aml_disposal_runs SET state='completed',object_keys='{}',completed_by=actor_id,
    completed_at=disposed_at,record_count=total WHERE id=run.id;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION app.finalize_aml_disposal(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finalize_aml_disposal(uuid,uuid) TO pms_app;

CREATE FUNCTION app.list_aml_disposals(actor_id uuid)
  RETURNS TABLE(id uuid, schedule_id uuid, client_id uuid, governing_rule text, state text,
    prepared_by uuid, prepared_at timestamptz, completed_by uuid, completed_at timestamptz, record_count integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  RETURN QUERY SELECT r.id,r.schedule_id,r.client_id,r.governing_rule,r.state,r.prepared_by,r.prepared_at,
    r.completed_by,r.completed_at,r.record_count FROM app.aml_disposal_runs r ORDER BY r.id DESC LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_aml_disposals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_disposals(uuid) TO pms_app;

CREATE FUNCTION app.create_aml_export(export_id uuid,target_client uuid,encryption_context text,key_version smallint,
  nonce bytea,ciphertext bytea,auth_tag bytea,content_sha256 bytea,content_size integer,actor_id uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM 1 FROM app.clients WHERE id=target_client FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.aml_retention_write','1',true);
  INSERT INTO app.aml_exports(id,client_id,encryption_context,key_version,nonce,ciphertext,auth_tag,
    sha256,byte_size,created_by) VALUES(export_id,target_client,encryption_context,key_version,nonce,ciphertext,
    auth_tag,content_sha256,content_size,actor_id);
  RETURN export_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_aml_export(uuid,uuid,text,smallint,bytea,bytea,bytea,bytea,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_export(uuid,uuid,text,smallint,bytea,bytea,bytea,bytea,integer,uuid) TO pms_app;

CREATE FUNCTION app.list_aml_exports(actor_id uuid)
  RETURNS TABLE(id uuid,client_id uuid,sha256 bytea,byte_size integer,created_by uuid,created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  RETURN QUERY SELECT e.id,e.client_id,e.sha256,e.byte_size,e.created_by,e.created_at
    FROM app.aml_exports e ORDER BY e.id DESC LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION app.list_aml_exports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_exports(uuid) TO pms_app;

CREATE FUNCTION app.read_aml_export(target_export uuid,actor_id uuid)
  RETURNS SETOF app.aml_exports LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id,'compliance');
  RETURN QUERY SELECT * FROM app.aml_exports WHERE id=target_export;
END;
$$;
REVOKE ALL ON FUNCTION app.read_aml_export(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_export(uuid,uuid) TO pms_app;

ALTER TABLE app.aml_restricted_access_log DROP CONSTRAINT aml_restricted_access_log_action;
ALTER TABLE app.aml_restricted_access_log ADD CONSTRAINT aml_restricted_access_log_action
  CHECK (action IN ('view','download','export'));

CREATE FUNCTION app.create_aml_restricted_export(export_id uuid,target_report uuid,encryption_context text,key_version smallint,
  nonce bytea,ciphertext bytea,auth_tag bytea,content_sha256 bytea,content_size integer,actor_id uuid)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  PERFORM 1 FROM app.aml_internal_reports WHERE id=target_report FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.aml_retention_write','1',true);
  INSERT INTO app.aml_restricted_exports(id,report_id,encryption_context,key_version,nonce,ciphertext,auth_tag,
    sha256,byte_size,created_by) VALUES(export_id,target_report,encryption_context,key_version,nonce,ciphertext,
    auth_tag,content_sha256,content_size,actor_id);
  RETURN export_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_aml_restricted_export(uuid,uuid,text,smallint,bytea,bytea,bytea,bytea,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_restricted_export(uuid,uuid,text,smallint,bytea,bytea,bytea,bytea,integer,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_restricted_export(target_report uuid,target_export uuid,actor_id uuid)
  RETURNS SETOF app.aml_restricted_exports LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  PERFORM set_config('app.aml_restricted_write','1',true);
  INSERT INTO app.aml_restricted_access_log(report_id,action,accessed_by)
    SELECT report_id,'export',actor_id FROM app.aml_restricted_exports
    WHERE id=target_export AND report_id=target_report;
  RETURN QUERY SELECT * FROM app.aml_restricted_exports WHERE id=target_export AND report_id=target_report;
END;
$$;
REVOKE ALL ON FUNCTION app.read_aml_restricted_export(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_restricted_export(uuid,uuid,uuid) TO pms_app;
