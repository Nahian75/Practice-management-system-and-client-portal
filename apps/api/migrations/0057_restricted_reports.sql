-- Compliance / AML step 15e: separately encrypted internal disclosures and
-- nominated-officer-only SAR/DAML records.

CREATE TABLE app.aml_internal_reports (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES app.clients(id),
  matter_id uuid REFERENCES app.matters(id),
  finance_transaction_id uuid,
  observed_on date NOT NULL,
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app.accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_internal_reports_date_valid CHECK (observed_on BETWEEN DATE '1900-01-01' AND app.london_today()),
  CONSTRAINT aml_internal_reports_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 200000),
  CONSTRAINT aml_internal_reports_context_valid CHECK (encryption_context = 'suspicion-report:' || id::text)
);
CREATE INDEX aml_internal_reports_queue_idx ON app.aml_internal_reports (id DESC);

CREATE TABLE app.aml_internal_report_attachments (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES app.aml_internal_reports(id),
  metadata_context text NOT NULL UNIQUE,
  metadata_key_version smallint NOT NULL,
  metadata_nonce bytea NOT NULL,
  metadata_ciphertext bytea NOT NULL,
  metadata_auth_tag bytea NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 bytea NOT NULL,
  storage_key text NOT NULL UNIQUE,
  file_key_version smallint NOT NULL,
  file_key_nonce bytea NOT NULL,
  wrapped_file_key bytea NOT NULL,
  file_key_tag bytea NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_internal_report_attachment_size CHECK (size_bytes BETWEEN 1 AND 52428800),
  CONSTRAINT aml_internal_report_attachment_hash CHECK (octet_length(sha256) = 32),
  CONSTRAINT aml_internal_report_attachment_metadata_crypto CHECK (metadata_key_version > 0
    AND octet_length(metadata_nonce) = 12 AND octet_length(metadata_auth_tag) = 16
    AND octet_length(metadata_ciphertext) BETWEEN 2 AND 5000),
  CONSTRAINT aml_internal_report_attachment_key_crypto CHECK (file_key_version > 0
    AND octet_length(file_key_nonce) = 12 AND octet_length(file_key_tag) = 16
    AND octet_length(wrapped_file_key) = 32),
  CONSTRAINT aml_internal_report_attachment_context CHECK (metadata_context = 'suspicion-attachment:' || id::text),
  CONSTRAINT aml_internal_report_attachment_storage CHECK
    (storage_key ~ '^compliance/restricted/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE TABLE app.aml_internal_report_decisions (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL UNIQUE REFERENCES app.aml_internal_reports(id),
  external_report_required boolean NOT NULL,
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  decided_by uuid NOT NULL REFERENCES app.accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_internal_report_decisions_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 100000),
  CONSTRAINT aml_internal_report_decisions_context CHECK (encryption_context = 'suspicion-decision:' || id::text)
);

CREATE TABLE app.aml_external_reports (
  id uuid PRIMARY KEY,
  internal_report_id uuid NOT NULL UNIQUE REFERENCES app.aml_internal_reports(id),
  report_kind text NOT NULL,
  daml_datf_requested boolean NOT NULL,
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app.accounts(id),
  submitted_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_external_reports_kind CHECK (report_kind IN ('sar', 'terrorist_financing_report')),
  CONSTRAINT aml_external_reports_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 100000),
  CONSTRAINT aml_external_reports_context CHECK (encryption_context = 'external-report:' || id::text)
);

CREATE TABLE app.aml_daml_datf_events (
  id uuid PRIMARY KEY,
  external_report_id uuid NOT NULL REFERENCES app.aml_external_reports(id),
  outcome text NOT NULL,
  received_at timestamptz NOT NULL,
  expires_at timestamptz,
  encryption_context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_daml_datf_events_outcome CHECK (outcome IN ('requested', 'granted', 'refused', 'withdrawn', 'expired')),
  CONSTRAINT aml_daml_datf_events_expiry CHECK (expires_at IS NULL OR expires_at >= received_at),
  CONSTRAINT aml_daml_datf_events_crypto CHECK (key_version > 0 AND octet_length(nonce) = 12
    AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 100000),
  CONSTRAINT aml_daml_datf_events_context CHECK (encryption_context = 'daml-datf-event:' || id::text)
);
CREATE INDEX aml_daml_datf_events_report_idx ON app.aml_daml_datf_events (external_report_id, id);

CREATE TABLE app.aml_restricted_hold_links (
  report_id uuid PRIMARY KEY REFERENCES app.aml_internal_reports(id),
  hold_id uuid NOT NULL UNIQUE REFERENCES app.aml_holds(id)
);

CREATE TABLE app.aml_restricted_access_log (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  report_id uuid NOT NULL REFERENCES app.aml_internal_reports(id),
  attachment_id uuid REFERENCES app.aml_internal_report_attachments(id),
  action text NOT NULL,
  accessed_by uuid NOT NULL REFERENCES app.accounts(id),
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_restricted_access_log_action CHECK (action IN ('view', 'download'))
);
CREATE INDEX aml_restricted_access_log_report_idx ON app.aml_restricted_access_log (report_id, id);

REVOKE ALL ON app.aml_internal_reports, app.aml_internal_report_attachments,
  app.aml_internal_report_decisions, app.aml_external_reports, app.aml_daml_datf_events,
  app.aml_restricted_hold_links, app.aml_restricted_access_log FROM pms_app;

CREATE FUNCTION app.protect_aml_restricted_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.aml_restricted_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'restricted records change only through protected functions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_aml_restricted_write() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_internal_reports','aml_internal_report_attachments',
    'aml_internal_report_decisions','aml_external_reports','aml_daml_datf_events',
    'aml_restricted_hold_links','aml_restricted_access_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_aml_restricted_write()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.assert_aml_reporter(actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts a JOIN app.account_roles r ON r.account_id = a.id
    WHERE a.id = actor_id AND a.kind = 'staff' AND a.status = 'active' AND r.revoked_at IS NULL
    FOR SHARE OF a, r;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff required' USING ERRCODE = 'insufficient_privilege'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_aml_reporter(uuid) FROM PUBLIC;

CREATE FUNCTION app.assert_aml_nominated_officer(actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('app.protected_roles', 0));
  PERFORM 1 FROM app.accounts a
    JOIN app.account_roles r ON r.account_id = a.id AND r.role = 'compliance' AND r.revoked_at IS NULL
    JOIN app.aml_officer_appointments o ON o.account_id = a.id AND o.kind = 'nominated_officer' AND o.ended_at IS NULL
    WHERE a.id = actor_id AND a.kind = 'staff' AND a.status = 'active'
    FOR SHARE OF a, r, o;
  IF NOT FOUND THEN RAISE EXCEPTION 'current nominated officer required' USING ERRCODE = 'insufficient_privilege'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_aml_nominated_officer(uuid) FROM PUBLIC;

-- A generic operational hold linked to a restricted report still looks ordinary
-- outside this module, but only a current nominated officer may release it.
CREATE OR REPLACE FUNCTION app.lift_aml_hold(target_id uuid, target_hold uuid,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE hold app.aml_holds%ROWTYPE;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  SELECT * INTO hold FROM app.aml_holds WHERE id = target_hold FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF EXISTS (SELECT 1 FROM app.aml_restricted_hold_links WHERE hold_id = target_hold) THEN
    PERFORM app.assert_aml_nominated_officer(actor_id);
  END IF;
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_hold_lifts(id, hold_id, encryption_context, key_version, nonce, ciphertext, auth_tag, lifted_by)
    VALUES (target_id, target_hold, selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.lift_aml_hold(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lift_aml_hold(uuid, uuid, text, smallint, bytea, bytea, bytea, uuid) TO pms_app;

CREATE FUNCTION app.submit_aml_internal_report(target_id uuid, target_client uuid, target_matter uuid,
  target_transaction uuid, selected_observed date, selected_context text, selected_key smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_reporter(actor_id);
  PERFORM 1 FROM app.clients WHERE id = target_client FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF target_matter IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.matters WHERE id = target_matter AND client_id = target_client FOR SHARE
  ) THEN RAISE NO_DATA_FOUND; END IF;
  IF target_transaction IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.finance_transactions WHERE id = target_transaction AND client_id = target_client
      AND (target_matter IS NULL OR matter_id = target_matter) FOR SHARE
  ) THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_internal_reports(id, client_id, matter_id, finance_transaction_id, observed_on,
    encryption_context, key_version, nonce, ciphertext, auth_tag, submitted_by)
  VALUES(target_id, target_client, target_matter, target_transaction, selected_observed,
    selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_restricted_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.submit_aml_internal_report(uuid,uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_aml_internal_report(uuid,uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_aml_internal_report_attachment(target_id uuid, target_report uuid,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea,
  selected_media text, selected_size integer, selected_sha bytea, selected_storage text,
  file_key smallint, file_nonce bytea, wrapped_key bytea, file_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_reporter(actor_id);
  PERFORM 1 FROM app.aml_internal_reports WHERE id = target_report AND submitted_by = actor_id FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_internal_report_attachments(id, report_id, metadata_context, metadata_key_version,
    metadata_nonce, metadata_ciphertext, metadata_auth_tag, media_type, size_bytes, sha256, storage_key,
    file_key_version, file_key_nonce, wrapped_file_key, file_key_tag)
  VALUES(target_id, target_report, selected_context, selected_key, selected_nonce, selected_ciphertext,
    selected_tag, selected_media, selected_size, selected_sha, selected_storage, file_key, file_nonce, wrapped_key, file_tag);
  PERFORM set_config('app.aml_restricted_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.add_aml_internal_report_attachment(uuid,uuid,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_internal_report_attachment(uuid,uuid,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.decide_aml_internal_report(target_id uuid, target_report uuid, report_required boolean,
  selected_context text, selected_key smallint, selected_nonce bytea, selected_ciphertext bytea,
  selected_tag bytea, linked_hold uuid, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  PERFORM 1 FROM app.aml_internal_reports WHERE id = target_report FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF linked_hold IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.aml_holds WHERE id = linked_hold AND imposed_by = actor_id) THEN
    RAISE EXCEPTION 'the restricted hold is not valid' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_internal_report_decisions(id, report_id, external_report_required,
    encryption_context, key_version, nonce, ciphertext, auth_tag, decided_by)
  VALUES(target_id, target_report, report_required, selected_context, selected_key, selected_nonce,
    selected_ciphertext, selected_tag, actor_id);
  IF linked_hold IS NOT NULL THEN INSERT INTO app.aml_restricted_hold_links(report_id, hold_id) VALUES(target_report, linked_hold); END IF;
  PERFORM set_config('app.aml_restricted_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.decide_aml_internal_report(uuid,uuid,boolean,text,smallint,bytea,bytea,bytea,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_aml_internal_report(uuid,uuid,boolean,text,smallint,bytea,bytea,bytea,uuid,uuid) TO pms_app;

CREATE FUNCTION app.record_aml_external_report(target_id uuid, target_report uuid, selected_kind text,
  requested boolean, selected_submitted timestamptz, selected_context text, selected_key smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  IF NOT EXISTS (SELECT 1 FROM app.aml_internal_report_decisions WHERE report_id = target_report AND external_report_required FOR SHARE) THEN
    RAISE EXCEPTION 'an external report needs a report-required decision' USING ERRCODE = 'check_violation';
  END IF;
  IF selected_submitted > clock_timestamp() THEN RAISE EXCEPTION 'external submission cannot be in the future' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_external_reports(id, internal_report_id, report_kind, daml_datf_requested,
    encryption_context, key_version, nonce, ciphertext, auth_tag, submitted_by, submitted_at)
  VALUES(target_id, target_report, selected_kind, requested, selected_context, selected_key, selected_nonce,
    selected_ciphertext, selected_tag, actor_id, selected_submitted);
  PERFORM set_config('app.aml_restricted_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_external_report(uuid,uuid,text,boolean,timestamptz,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_external_report(uuid,uuid,text,boolean,timestamptz,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_aml_daml_datf_event(target_id uuid, target_external uuid, selected_outcome text,
  selected_received timestamptz, selected_expires timestamptz, selected_context text, selected_key smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_tag bytea, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  PERFORM 1 FROM app.aml_external_reports WHERE id = target_external AND daml_datf_requested FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_received > clock_timestamp() THEN RAISE EXCEPTION 'status cannot be received in the future' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_daml_datf_events(id, external_report_id, outcome, received_at, expires_at,
    encryption_context, key_version, nonce, ciphertext, auth_tag, recorded_by)
  VALUES(target_id, target_external, selected_outcome, selected_received, selected_expires,
    selected_context, selected_key, selected_nonce, selected_ciphertext, selected_tag, actor_id);
  PERFORM set_config('app.aml_restricted_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_daml_datf_event(uuid,uuid,text,timestamptz,timestamptz,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_daml_datf_event(uuid,uuid,text,timestamptz,timestamptz,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

-- Read functions return ciphertext only after the live appointment check. Decryption stays outside PostgreSQL.
CREATE FUNCTION app.list_aml_internal_reports(actor_id uuid, before_id uuid)
  RETURNS TABLE(id uuid, observed_on date, submitted_at timestamptz, decided boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT r.id, r.observed_on, r.submitted_at, d.id IS NOT NULL
    FROM app.aml_internal_reports r LEFT JOIN app.aml_internal_report_decisions d ON d.report_id = r.id
    WHERE before_id IS NULL OR r.id < before_id ORDER BY r.id DESC LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION app.list_aml_internal_reports(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_internal_reports(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_internal_report(target_report uuid, actor_id uuid)
  RETURNS SETOF app.aml_internal_reports
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  IF NOT EXISTS (SELECT 1 FROM app.aml_internal_reports WHERE id = target_report) THEN RETURN; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_restricted_access_log(report_id, action, accessed_by) VALUES(target_report, 'view', actor_id);
  PERFORM set_config('app.aml_restricted_write', '0', true);
  RETURN QUERY SELECT * FROM app.aml_internal_reports WHERE id = target_report;
END;
$$;
REVOKE ALL ON FUNCTION app.read_aml_internal_report(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_internal_report(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_internal_report_attachments(target_report uuid, actor_id uuid)
  RETURNS SETOF app.aml_internal_report_attachments
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT * FROM app.aml_internal_report_attachments WHERE report_id = target_report ORDER BY id;
END; $$;
REVOKE ALL ON FUNCTION app.read_aml_internal_report_attachments(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_internal_report_attachments(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_internal_report_decision(target_report uuid, actor_id uuid)
  RETURNS SETOF app.aml_internal_report_decisions
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT * FROM app.aml_internal_report_decisions WHERE report_id = target_report;
END; $$;
REVOKE ALL ON FUNCTION app.read_aml_internal_report_decision(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_internal_report_decision(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_external_reports(target_report uuid, actor_id uuid)
  RETURNS SETOF app.aml_external_reports
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT * FROM app.aml_external_reports WHERE internal_report_id = target_report;
END; $$;
REVOKE ALL ON FUNCTION app.read_aml_external_reports(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_external_reports(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_aml_daml_datf_events(target_external uuid, actor_id uuid)
  RETURNS SETOF app.aml_daml_datf_events
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT * FROM app.aml_daml_datf_events WHERE external_report_id = target_external ORDER BY id;
END; $$;
REVOKE ALL ON FUNCTION app.read_aml_daml_datf_events(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_daml_datf_events(uuid,uuid) TO pms_app;

CREATE FUNCTION app.download_aml_internal_report_attachment(target_attachment uuid, actor_id uuid)
  RETURNS SETOF app.aml_internal_report_attachments
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_report uuid;
BEGIN
  PERFORM app.assert_aml_nominated_officer(actor_id);
  SELECT report_id INTO target_report FROM app.aml_internal_report_attachments WHERE id = target_attachment;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM set_config('app.aml_restricted_write', '1', true);
  INSERT INTO app.aml_restricted_access_log(report_id, attachment_id, action, accessed_by)
    VALUES(target_report, target_attachment, 'download', actor_id);
  PERFORM set_config('app.aml_restricted_write', '0', true);
  RETURN QUERY SELECT * FROM app.aml_internal_report_attachments WHERE id = target_attachment;
END;
$$;
REVOKE ALL ON FUNCTION app.download_aml_internal_report_attachment(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.download_aml_internal_report_attachment(uuid,uuid) TO pms_app;

CREATE FUNCTION app.list_aml_restricted_access(target_report uuid, actor_id uuid)
  RETURNS TABLE(id uuid, action text, attachment_id uuid, accessed_by uuid, accessed_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN PERFORM app.assert_aml_nominated_officer(actor_id);
  RETURN QUERY SELECT l.id, l.action, l.attachment_id, l.accessed_by, l.accessed_at
    FROM app.aml_restricted_access_log l WHERE l.report_id = target_report ORDER BY l.id;
END; $$;
REVOKE ALL ON FUNCTION app.list_aml_restricted_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_aml_restricted_access(uuid,uuid) TO pms_app;
