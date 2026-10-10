-- Compliance / AML step 15b: versioned client CDD and separately protected evidence.

CREATE TABLE app.aml_cdd_cases (
  id uuid PRIMARY KEY DEFAULT uuidv7(), client_id uuid NOT NULL REFERENCES app.clients(id),
  version integer NOT NULL, status text NOT NULL DEFAULT 'draft',
  intended_relationship text NOT NULL, reason text NOT NULL,
  client_snapshot jsonb, prepared_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz,
  abandoned_by uuid REFERENCES app.accounts(id), abandoned_at timestamptz, abandonment_reason text,
  CONSTRAINT aml_cdd_cases_version_positive CHECK (version > 0),
  CONSTRAINT aml_cdd_cases_status_valid CHECK (status IN ('draft', 'submitted', 'abandoned')),
  CONSTRAINT aml_cdd_cases_relationship_safe CHECK (app.is_safe_document_text(intended_relationship) AND length(intended_relationship) BETWEEN 10 AND 5000),
  CONSTRAINT aml_cdd_cases_reason_safe CHECK (app.is_safe_document_text(reason) AND length(reason) BETWEEN 10 AND 5000),
  CONSTRAINT aml_cdd_cases_state_complete CHECK (
    (status = 'draft' AND client_snapshot IS NULL AND submitted_at IS NULL AND abandoned_by IS NULL AND abandoned_at IS NULL AND abandonment_reason IS NULL)
    OR (status = 'submitted' AND client_snapshot IS NOT NULL AND submitted_at IS NOT NULL AND abandoned_by IS NULL AND abandoned_at IS NULL AND abandonment_reason IS NULL)
    OR (status = 'abandoned' AND client_snapshot IS NULL AND submitted_at IS NULL AND abandoned_by IS NOT NULL AND abandoned_at IS NOT NULL
      AND app.is_safe_text(abandonment_reason) AND length(abandonment_reason) BETWEEN 10 AND 500)),
  CONSTRAINT aml_cdd_cases_client_version_unique UNIQUE (client_id, version)
);
CREATE UNIQUE INDEX aml_cdd_cases_one_draft ON app.aml_cdd_cases(client_id) WHERE status = 'draft';
CREATE INDEX aml_cdd_cases_client_recent ON app.aml_cdd_cases(client_id, id DESC);

CREATE TABLE app.aml_cdd_case_controls (
  cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  control_version_id uuid NOT NULL REFERENCES app.aml_control_versions(id),
  kind text NOT NULL,
  PRIMARY KEY (cdd_case_id, kind), UNIQUE (cdd_case_id, control_version_id)
);

CREATE TABLE app.aml_cdd_subjects (
  id uuid PRIMARY KEY, cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  kind text NOT NULL, relationship text NOT NULL,
  encryption_context text NOT NULL UNIQUE, key_version smallint NOT NULL,
  nonce bytea NOT NULL, ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_cdd_subjects_kind_valid CHECK (kind IN ('individual', 'legal_entity')),
  CONSTRAINT aml_cdd_subjects_relationship_valid CHECK (relationship IN (
    'client', 'authorised_representative', 'director_senior_manager', 'beneficial_owner',
    'trustee', 'settlor', 'beneficiary', 'protector', 'funder', 'other_controller')),
  CONSTRAINT aml_cdd_subjects_crypto_valid CHECK (key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_cdd_subjects_context_valid CHECK (encryption_context = 'aml-subject:' || id::text)
);
CREATE INDEX aml_cdd_subjects_case_idx ON app.aml_cdd_subjects(cdd_case_id, id);

CREATE TABLE app.aml_cdd_evidence (
  id uuid PRIMARY KEY, cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  evidence_type text NOT NULL, country char(2), issued_on date, expires_on date,
  metadata_context text NOT NULL UNIQUE, metadata_key_version smallint NOT NULL,
  metadata_nonce bytea NOT NULL, metadata_ciphertext bytea NOT NULL, metadata_auth_tag bytea NOT NULL,
  media_type text NOT NULL, size_bytes integer NOT NULL, sha256 bytea NOT NULL,
  storage_key text NOT NULL UNIQUE, file_key_version smallint NOT NULL,
  file_key_nonce bytea NOT NULL, wrapped_file_key bytea NOT NULL, file_key_tag bytea NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES app.accounts(id), uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_cdd_evidence_type_safe CHECK (app.is_safe_text(evidence_type) AND length(evidence_type) BETWEEN 1 AND 100),
  CONSTRAINT aml_cdd_evidence_country_valid CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  CONSTRAINT aml_cdd_evidence_dates_valid CHECK (issued_on IS NULL OR issued_on >= DATE '1900-01-01') ,
  CONSTRAINT aml_cdd_evidence_expiry_valid CHECK (expires_on IS NULL OR (expires_on >= DATE '1900-01-01' AND (issued_on IS NULL OR expires_on >= issued_on))),
  CONSTRAINT aml_cdd_evidence_metadata_crypto CHECK (metadata_key_version > 0 AND octet_length(metadata_nonce) = 12 AND octet_length(metadata_auth_tag) = 16 AND octet_length(metadata_ciphertext) BETWEEN 2 AND 10000),
  CONSTRAINT aml_cdd_evidence_context_valid CHECK (metadata_context = 'aml-evidence-metadata:' || id::text),
  CONSTRAINT aml_cdd_evidence_media_valid CHECK (media_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','image/jpeg','image/png','message/rfc822')),
  CONSTRAINT aml_cdd_evidence_size_valid CHECK (size_bytes BETWEEN 1 AND 52428800),
  CONSTRAINT aml_cdd_evidence_hash_valid CHECK (octet_length(sha256) = 32),
  CONSTRAINT aml_cdd_evidence_storage_valid CHECK (storage_key ~ '^compliance/[0-9a-f-]{36}$'),
  CONSTRAINT aml_cdd_evidence_file_crypto CHECK (file_key_version > 0 AND octet_length(file_key_nonce) = 12 AND octet_length(wrapped_file_key) = 32 AND octet_length(file_key_tag) = 16)
);
CREATE INDEX aml_cdd_evidence_case_idx ON app.aml_cdd_evidence(cdd_case_id, id);

CREATE TABLE app.aml_cdd_ownership_controls (
  id uuid PRIMARY KEY, cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  owned_subject_id uuid NOT NULL REFERENCES app.aml_cdd_subjects(id), controller_subject_id uuid NOT NULL REFERENCES app.aml_cdd_subjects(id),
  ownership_percent numeric(5,2), control_kind text NOT NULL,
  details_context text NOT NULL UNIQUE, details_key_version smallint NOT NULL,
  details_nonce bytea NOT NULL, details_ciphertext bytea NOT NULL, details_auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_cdd_ownership_distinct CHECK (owned_subject_id <> controller_subject_id),
  CONSTRAINT aml_cdd_ownership_percent CHECK (ownership_percent IS NULL OR ownership_percent BETWEEN 0.01 AND 100),
  CONSTRAINT aml_cdd_ownership_kind CHECK (control_kind IN ('ownership','voting_rights','appointment_rights','significant_influence','other')),
  CONSTRAINT aml_cdd_ownership_crypto CHECK (details_key_version > 0 AND octet_length(details_nonce)=12 AND octet_length(details_auth_tag)=16 AND octet_length(details_ciphertext) BETWEEN 2 AND 10000),
  CONSTRAINT aml_cdd_ownership_context CHECK (details_context = 'aml-ownership:' || id::text)
);

CREATE TABLE app.aml_cdd_authorities (
  id uuid PRIMARY KEY, cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  representative_subject_id uuid NOT NULL REFERENCES app.aml_cdd_subjects(id),
  represented_subject_id uuid NOT NULL REFERENCES app.aml_cdd_subjects(id),
  evidence_id uuid NOT NULL REFERENCES app.aml_cdd_evidence(id), authority_type text NOT NULL,
  verified_on date NOT NULL, details_context text NOT NULL UNIQUE, details_key_version smallint NOT NULL,
  details_nonce bytea NOT NULL, details_ciphertext bytea NOT NULL, details_auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_cdd_authorities_distinct CHECK (representative_subject_id <> represented_subject_id),
  CONSTRAINT aml_cdd_authorities_type_safe CHECK (app.is_safe_text(authority_type) AND length(authority_type) BETWEEN 1 AND 100),
  CONSTRAINT aml_cdd_authorities_date CHECK (verified_on >= DATE '1900-01-01'),
  CONSTRAINT aml_cdd_authorities_crypto CHECK (details_key_version > 0 AND octet_length(details_nonce)=12 AND octet_length(details_auth_tag)=16 AND octet_length(details_ciphertext) BETWEEN 2 AND 10000),
  CONSTRAINT aml_cdd_authorities_context CHECK (details_context = 'aml-authority:' || id::text)
);

CREATE TABLE app.aml_cdd_verifications (
  id uuid PRIMARY KEY, cdd_case_id uuid NOT NULL REFERENCES app.aml_cdd_cases(id),
  subject_id uuid NOT NULL REFERENCES app.aml_cdd_subjects(id), evidence_id uuid NOT NULL REFERENCES app.aml_cdd_evidence(id),
  source_type text NOT NULL, country char(2), checked_on date NOT NULL, expires_on date,
  method text NOT NULL, outcome text NOT NULL, provider text, service text,
  details_context text NOT NULL UNIQUE, details_key_version smallint NOT NULL,
  details_nonce bytea NOT NULL, details_ciphertext bytea NOT NULL, details_auth_tag bytea NOT NULL,
  verified_by uuid NOT NULL REFERENCES app.accounts(id), verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aml_cdd_verifications_source_safe CHECK (app.is_safe_text(source_type) AND length(source_type) BETWEEN 1 AND 100),
  CONSTRAINT aml_cdd_verifications_country CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  CONSTRAINT aml_cdd_verifications_dates CHECK (checked_on >= DATE '1900-01-01' AND (expires_on IS NULL OR expires_on >= checked_on)),
  CONSTRAINT aml_cdd_verifications_method CHECK (method IN ('manual','electronic','certified_copy','in_person','other')),
  CONSTRAINT aml_cdd_verifications_outcome CHECK (outcome IN ('verified','failed','inconclusive')),
  CONSTRAINT aml_cdd_verifications_provider CHECK (provider IS NULL OR (app.is_safe_text(provider) AND length(provider) BETWEEN 1 AND 200)),
  CONSTRAINT aml_cdd_verifications_service CHECK (service IS NULL OR (app.is_safe_text(service) AND length(service) BETWEEN 1 AND 200)),
  CONSTRAINT aml_cdd_verifications_crypto CHECK (details_key_version > 0 AND octet_length(details_nonce)=12 AND octet_length(details_auth_tag)=16 AND octet_length(details_ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT aml_cdd_verifications_context CHECK (details_context = 'aml-verification:' || id::text)
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_cdd_cases, app.aml_cdd_case_controls,
  app.aml_cdd_subjects, app.aml_cdd_evidence, app.aml_cdd_ownership_controls,
  app.aml_cdd_authorities, app.aml_cdd_verifications FROM pms_app;

CREATE FUNCTION app.protect_aml_cdd_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  IF current_setting('app.aml_cdd_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'CDD records are written only through protected functions' USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME <> 'aml_cdd_cases' THEN
    EXECUTE format('select status from app.aml_cdd_cases where id = ($1).%I', 'cdd_case_id') INTO parent_status USING NEW;
    IF parent_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'CDD facts can be added only to a draft' USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION app.protect_aml_cdd_insert() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_cdd_cases','aml_cdd_case_controls','aml_cdd_subjects','aml_cdd_evidence','aml_cdd_ownership_controls','aml_cdd_authorities','aml_cdd_verifications'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_aml_cdd_insert()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.refuse_aml_cdd_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CDD history is immutable' USING ERRCODE = 'insufficient_privilege'; END; $$;
REVOKE ALL ON FUNCTION app.refuse_aml_cdd_history_change() FROM PUBLIC;

CREATE FUNCTION app.protect_aml_cdd_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
END; $$;
REVOKE ALL ON FUNCTION app.protect_aml_cdd_case() FROM PUBLIC;
CREATE TRIGGER aml_cdd_cases_fixed BEFORE UPDATE OR DELETE ON app.aml_cdd_cases FOR EACH ROW EXECUTE FUNCTION app.protect_aml_cdd_case();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_cdd_case_controls','aml_cdd_subjects','aml_cdd_evidence','aml_cdd_ownership_controls','aml_cdd_authorities','aml_cdd_verifications'] LOOP
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_cdd_history_change()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.refuse_aml_cdd_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CDD history cannot be truncated' USING ERRCODE = 'insufficient_privilege'; END; $$;
REVOKE ALL ON FUNCTION app.refuse_aml_cdd_truncate() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_cdd_cases','aml_cdd_case_controls','aml_cdd_subjects','aml_cdd_evidence','aml_cdd_ownership_controls','aml_cdd_authorities','aml_cdd_verifications'] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_cdd_truncate()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.assert_aml_client_access(actor_id uuid, target_client uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE responsible uuid;
BEGIN
  SELECT responsible_id INTO responsible FROM app.clients WHERE id=target_client FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.accounts WHERE id=actor_id AND kind='staff' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML client access required' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM 1 FROM app.account_roles WHERE account_id=actor_id AND role='compliance' AND revoked_at IS NULL FOR SHARE;
  IF FOUND THEN RETURN; END IF;
  PERFORM 1 FROM app.account_roles WHERE account_id=actor_id AND role IN ('partner','fee_earner') AND revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML client access required' USING ERRCODE='insufficient_privilege'; END IF;
  IF responsible=actor_id THEN RETURN; END IF;
  PERFORM 1 FROM app.matters m JOIN app.matter_team mt ON mt.matter_id=m.id
    WHERE m.client_id=target_client AND mt.account_id=actor_id AND mt.removed_at IS NULL
    FOR SHARE OF m,mt;
  IF NOT FOUND THEN RAISE EXCEPTION 'active AML client access required' USING ERRCODE='insufficient_privilege'; END IF;
END; $$;
REVOKE ALL ON FUNCTION app.assert_aml_client_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_aml_client_access(uuid, uuid) TO pms_app;

CREATE FUNCTION app.create_aml_cdd_case(target_client uuid, selected_relationship text, selected_reason text, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid; next_version integer;
BEGIN
  PERFORM app.assert_aml_client_access(actor_id,target_client);
  PERFORM 1 FROM app.clients WHERE id=target_client FOR SHARE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_cdd:'||target_client::text,0));
  SELECT coalesce(max(version),0)+1 INTO next_version FROM app.aml_cdd_cases WHERE client_id=target_client;
  PERFORM set_config('app.aml_cdd_write','1',true);
  INSERT INTO app.aml_cdd_cases(client_id,version,intended_relationship,reason,prepared_by)
    VALUES(target_client,next_version,selected_relationship,selected_reason,actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END; $$;
REVOKE ALL ON FUNCTION app.create_aml_cdd_case(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_cdd_case(uuid,text,text,uuid) TO pms_app;

CREATE FUNCTION app.assert_aml_cdd_draft(target_case uuid, actor_id uuid) RETURNS app.aml_cdd_cases
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target app.aml_cdd_cases%ROWTYPE;
BEGIN
  SELECT * INTO target FROM app.aml_cdd_cases WHERE id=target_case FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_aml_client_access(actor_id,target.client_id);
  IF target.status <> 'draft' THEN RAISE EXCEPTION 'CDD case is already submitted' USING ERRCODE='check_violation'; END IF;
  PERFORM set_config('app.aml_cdd_write','1',true);
  RETURN target;
END; $$;
REVOKE ALL ON FUNCTION app.assert_aml_cdd_draft(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.add_aml_cdd_subject(target_id uuid,target_case uuid,selected_kind text,selected_relationship text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_cdd_draft(target_case,actor_id);
  INSERT INTO app.aml_cdd_subjects(id,cdd_case_id,kind,relationship,encryption_context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_case,selected_kind,selected_relationship,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END; $$;
REVOKE ALL ON FUNCTION app.add_aml_cdd_subject(uuid,uuid,text,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_cdd_subject(uuid,uuid,text,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_aml_cdd_evidence(target_id uuid,target_case uuid,selected_type text,selected_country char(2),selected_issued date,selected_expires date,
  metadata_context text,metadata_key smallint,metadata_nonce bytea,metadata_ciphertext bytea,metadata_tag bytea,
  selected_media text,selected_size integer,selected_hash bytea,selected_storage text,file_key smallint,file_nonce bytea,file_wrapped bytea,file_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_cdd_draft(target_case,actor_id);
  IF selected_issued IS NOT NULL AND selected_issued > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'evidence cannot be issued in the future' USING ERRCODE='check_violation'; END IF;
  INSERT INTO app.aml_cdd_evidence(id,cdd_case_id,evidence_type,country,issued_on,expires_on,metadata_context,metadata_key_version,metadata_nonce,metadata_ciphertext,metadata_auth_tag,media_type,size_bytes,sha256,storage_key,file_key_version,file_key_nonce,wrapped_file_key,file_key_tag,uploaded_by)
    VALUES(target_id,target_case,selected_type,selected_country,selected_issued,selected_expires,metadata_context,metadata_key,metadata_nonce,metadata_ciphertext,metadata_tag,selected_media,selected_size,selected_hash,selected_storage,file_key,file_nonce,file_wrapped,file_tag,actor_id);
END; $$;
REVOKE ALL ON FUNCTION app.add_aml_cdd_evidence(uuid,uuid,text,char,date,date,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_cdd_evidence(uuid,uuid,text,char,date,date,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_aml_cdd_ownership(target_id uuid,target_case uuid,owned uuid,controller uuid,selected_percent numeric,selected_kind text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_cdd_draft(target_case,actor_id);
  IF NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects WHERE id=owned AND cdd_case_id=target_case AND kind='legal_entity')
     OR NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects WHERE id=controller AND cdd_case_id=target_case) THEN
    RAISE EXCEPTION 'ownership subjects must belong to this case' USING ERRCODE='check_violation'; END IF;
  INSERT INTO app.aml_cdd_ownership_controls(id,cdd_case_id,owned_subject_id,controller_subject_id,ownership_percent,control_kind,details_context,details_key_version,details_nonce,details_ciphertext,details_auth_tag,recorded_by)
    VALUES(target_id,target_case,owned,controller,selected_percent,selected_kind,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END; $$;
REVOKE ALL ON FUNCTION app.add_aml_cdd_ownership(uuid,uuid,uuid,uuid,numeric,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_cdd_ownership(uuid,uuid,uuid,uuid,numeric,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_aml_cdd_authority(target_id uuid,target_case uuid,representative uuid,represented uuid,evidence uuid,selected_type text,selected_on date,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_cdd_draft(target_case,actor_id);
  IF selected_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'authority cannot be verified in the future' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects WHERE id=representative AND cdd_case_id=target_case AND relationship='authorised_representative')
    OR NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects WHERE id=represented AND cdd_case_id=target_case)
    OR NOT EXISTS(SELECT 1 FROM app.aml_cdd_evidence WHERE id=evidence AND cdd_case_id=target_case) THEN
    RAISE EXCEPTION 'authority subjects and evidence must belong to this case' USING ERRCODE='check_violation'; END IF;
  INSERT INTO app.aml_cdd_authorities(id,cdd_case_id,representative_subject_id,represented_subject_id,evidence_id,authority_type,verified_on,details_context,details_key_version,details_nonce,details_ciphertext,details_auth_tag,recorded_by)
    VALUES(target_id,target_case,representative,represented,evidence,selected_type,selected_on,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END; $$;
REVOKE ALL ON FUNCTION app.add_aml_cdd_authority(uuid,uuid,uuid,uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_cdd_authority(uuid,uuid,uuid,uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_aml_cdd_verification(target_id uuid,target_case uuid,subject uuid,evidence uuid,selected_source text,selected_country char(2),selected_checked date,selected_expires date,selected_method text,selected_outcome text,selected_provider text,selected_service text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_aml_cdd_draft(target_case,actor_id);
  IF selected_checked > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'identity cannot be checked in the future' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects WHERE id=subject AND cdd_case_id=target_case)
    OR NOT EXISTS(SELECT 1 FROM app.aml_cdd_evidence WHERE id=evidence AND cdd_case_id=target_case) THEN
    RAISE EXCEPTION 'verification subject and evidence must belong to this case' USING ERRCODE='check_violation'; END IF;
  INSERT INTO app.aml_cdd_verifications(id,cdd_case_id,subject_id,evidence_id,source_type,country,checked_on,expires_on,method,outcome,provider,service,details_context,details_key_version,details_nonce,details_ciphertext,details_auth_tag,verified_by)
    VALUES(target_id,target_case,subject,evidence,selected_source,selected_country,selected_checked,selected_expires,selected_method,selected_outcome,selected_provider,selected_service,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END; $$;
REVOKE ALL ON FUNCTION app.add_aml_cdd_verification(uuid,uuid,uuid,uuid,text,char,date,date,text,text,text,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_aml_cdd_verification(uuid,uuid,uuid,uuid,text,char,date,date,text,text,text,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.submit_aml_cdd_case(target_case uuid,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target app.aml_cdd_cases%ROWTYPE; today date := (clock_timestamp() AT TIME ZONE 'Europe/London')::date; snapshot jsonb; control_kind text; selected_control uuid;
BEGIN
  SELECT * INTO target FROM app.aml_cdd_cases WHERE id=target_case FOR UPDATE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_aml_client_access(actor_id,target.client_id);
  IF target.status <> 'draft' THEN RAISE EXCEPTION 'CDD case is already submitted' USING ERRCODE='check_violation'; END IF;
  IF (SELECT count(*) FROM app.aml_cdd_subjects WHERE cdd_case_id=target_case AND relationship='client') <> 1 THEN
    RAISE EXCEPTION 'CDD needs exactly one client subject' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.aml_cdd_subjects s JOIN app.clients c ON c.id=target.client_id
    WHERE s.cdd_case_id=target_case AND s.relationship='client'
      AND ((c.kind='individual' AND s.kind='individual') OR (c.kind='organisation' AND s.kind='legal_entity'))) THEN
    RAISE EXCEPTION 'the client subject kind must match the client' USING ERRCODE='check_violation'; END IF;
  IF EXISTS(SELECT 1 FROM app.aml_cdd_subjects s WHERE s.cdd_case_id=target_case AND NOT EXISTS(
    SELECT 1 FROM app.aml_cdd_verifications v WHERE v.subject_id=s.id AND v.outcome='verified' AND (v.expires_on IS NULL OR v.expires_on>=today))) THEN
    RAISE EXCEPTION 'every subject needs current successful verification' USING ERRCODE='check_violation'; END IF;
  IF EXISTS(SELECT 1 FROM app.aml_cdd_subjects s WHERE s.cdd_case_id=target_case AND s.relationship='authorised_representative' AND NOT EXISTS(
    SELECT 1 FROM app.aml_cdd_authorities a WHERE a.representative_subject_id=s.id)) THEN
    RAISE EXCEPTION 'every representative needs verified authority' USING ERRCODE='check_violation'; END IF;
  PERFORM set_config('app.aml_cdd_write','1',true);
  FOREACH control_kind IN ARRAY ARRAY['ml_tf_risk_assessment','proliferation_financing_risk_assessment','sanctions_risk_assessment','aml_policy','sanctions_policy'] LOOP
    SELECT v.id INTO selected_control FROM app.aml_control_versions v JOIN app.aml_control_approvals p ON p.control_version_id=v.id
      WHERE v.kind=control_kind AND v.effective_from<=today AND v.review_due_on>=today ORDER BY v.version DESC LIMIT 1 FOR SHARE OF v,p;
    IF selected_control IS NULL THEN RAISE EXCEPTION 'CDD needs current approved firm controls' USING ERRCODE='check_violation'; END IF;
    INSERT INTO app.aml_cdd_case_controls(cdd_case_id,control_version_id,kind) VALUES(target_case,selected_control,control_kind);
    selected_control := NULL;
  END LOOP;
  PERFORM 1 FROM app.clients WHERE id=target.client_id FOR SHARE;
  PERFORM 1 FROM app.client_individuals WHERE client_id=target.client_id FOR SHARE;
  PERFORM 1 FROM app.client_organisations WHERE client_id=target.client_id FOR SHARE;
  SELECT jsonb_strip_nulls(jsonb_build_object('reference',c.reference,'kind',c.kind,'status',c.status,
    'name',coalesce(o.legal_name,i.given_names||' '||i.family_name),'dateOfBirth',i.date_of_birth,
    'organisationType',o.organisation_type,'registrationNumber',o.registration_number,
    'email',coalesce(o.email,i.email),'phone',coalesce(o.phone,i.phone),'addressLine1',coalesce(o.address_line1,i.address_line1),
    'addressLine2',coalesce(o.address_line2,i.address_line2),'town',coalesce(o.town,i.town),
    'postcode',coalesce(o.postcode,i.postcode),'country',coalesce(o.country,i.country))) INTO snapshot
    FROM app.clients c LEFT JOIN app.client_individuals i ON i.client_id=c.id LEFT JOIN app.client_organisations o ON o.client_id=c.id WHERE c.id=target.client_id;
  PERFORM set_config('app.aml_cdd_submit','1',true);
  UPDATE app.aml_cdd_cases SET status='submitted',client_snapshot=snapshot,submitted_at=clock_timestamp() WHERE id=target_case;
  PERFORM set_config('app.aml_cdd_submit','0',true);
END; $$;
REVOKE ALL ON FUNCTION app.submit_aml_cdd_case(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_aml_cdd_case(uuid,uuid) TO pms_app;

CREATE FUNCTION app.abandon_aml_cdd_case(target_case uuid,selected_reason text,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target app.aml_cdd_cases%ROWTYPE;
BEGIN
  SELECT * INTO target FROM app.aml_cdd_cases WHERE id=target_case FOR UPDATE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_aml_client_access(actor_id,target.client_id);
  IF target.status <> 'draft' THEN RAISE EXCEPTION 'only a draft CDD case can be abandoned' USING ERRCODE='check_violation'; END IF;
  PERFORM set_config('app.aml_cdd_abandon','1',true);
  UPDATE app.aml_cdd_cases SET status='abandoned',abandoned_by=actor_id,abandoned_at=clock_timestamp(),abandonment_reason=selected_reason WHERE id=target_case;
  PERFORM set_config('app.aml_cdd_abandon','0',true);
END; $$;
REVOKE ALL ON FUNCTION app.abandon_aml_cdd_case(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.abandon_aml_cdd_case(uuid,text,uuid) TO pms_app;
