-- Client onboarding addendum 17b-2: narrow client evidence requests and protected portal upload.

CREATE TABLE app.onboarding_evidence_requests (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id      uuid        NOT NULL REFERENCES app.clients(id),
  cdd_case_id    uuid        NOT NULL REFERENCES app.aml_cdd_cases(id),
  contact_id     uuid        REFERENCES app.client_contacts(id),
  evidence_type  text        NOT NULL,
  instructions   text        NOT NULL,
  country        char(2),
  due_on         date        NOT NULL,
  requested_by   uuid        NOT NULL REFERENCES app.accounts(id),
  requested_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT onboarding_evidence_type_safe CHECK (app.is_safe_text(evidence_type) AND length(evidence_type) BETWEEN 1 AND 100),
  CONSTRAINT onboarding_evidence_instructions_safe CHECK (app.is_safe_document_text(instructions) AND length(instructions) BETWEEN 10 AND 2000),
  CONSTRAINT onboarding_evidence_country_valid CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  CONSTRAINT onboarding_evidence_due_valid CHECK (due_on >= DATE '1900-01-01')
);
CREATE INDEX onboarding_evidence_client_idx ON app.onboarding_evidence_requests(client_id, requested_at DESC, id DESC);
CREATE INDEX onboarding_evidence_case_idx ON app.onboarding_evidence_requests(cdd_case_id, requested_at DESC, id DESC);

CREATE TABLE app.onboarding_evidence_submissions (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  request_id   uuid        NOT NULL UNIQUE REFERENCES app.onboarding_evidence_requests(id),
  evidence_id  uuid        NOT NULL UNIQUE REFERENCES app.aml_cdd_evidence(id),
  uploaded_by  uuid        NOT NULL REFERENCES app.accounts(id),
  uploaded_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.onboarding_evidence_requests, app.onboarding_evidence_submissions FROM pms_app;
CREATE TRIGGER onboarding_evidence_requests_fixed BEFORE UPDATE OR DELETE ON app.onboarding_evidence_requests
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER onboarding_evidence_submissions_fixed BEFORE UPDATE OR DELETE ON app.onboarding_evidence_submissions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER onboarding_evidence_requests_no_truncate BEFORE TRUNCATE ON app.onboarding_evidence_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER onboarding_evidence_submissions_no_truncate BEFORE TRUNCATE ON app.onboarding_evidence_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();

CREATE FUNCTION app.create_onboarding_evidence_request(target_client uuid,target_case uuid,target_contact uuid,
  selected_type text,selected_instructions text,selected_country char(2),selected_due date,actor_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid;
DECLARE client_kind text;
BEGIN
  PERFORM app.assert_aml_client_access(actor_id,target_client);
  SELECT kind INTO client_kind FROM app.clients WHERE id=target_client FOR SHARE;
  PERFORM 1 FROM app.aml_cdd_cases WHERE id=target_case AND client_id=target_client AND status='draft' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence requests require the current CDD draft' USING ERRCODE='check_violation'; END IF;
  IF selected_due < (clock_timestamp() AT TIME ZONE 'Europe/London')::date
      OR selected_due > (clock_timestamp() AT TIME ZONE 'Europe/London')::date + 365 THEN
    RAISE EXCEPTION 'the evidence due date is invalid' USING ERRCODE='check_violation';
  END IF;
  IF client_kind='individual' AND target_contact IS NOT NULL THEN
    RAISE EXCEPTION 'an individual client has no organisation contact' USING ERRCODE='check_violation';
  ELSIF client_kind='organisation' THEN
    PERFORM 1 FROM app.client_contacts WHERE id=target_contact AND client_id=target_client AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'an active organisation contact is required' USING ERRCODE='check_violation'; END IF;
  END IF;
  INSERT INTO app.onboarding_evidence_requests(client_id,cdd_case_id,contact_id,evidence_type,instructions,country,due_on,requested_by)
  VALUES(target_client,target_case,target_contact,selected_type,selected_instructions,selected_country,selected_due,actor_id)
  RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_onboarding_evidence_request(uuid,uuid,uuid,text,text,char,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_onboarding_evidence_request(uuid,uuid,uuid,text,text,char,date,uuid) TO pms_app;

CREATE FUNCTION app.add_portal_aml_evidence(target_request uuid,target_evidence uuid,
  metadata_context text,metadata_key_version smallint,metadata_nonce bytea,metadata_ciphertext bytea,metadata_tag bytea,
  selected_media text,selected_size integer,selected_hash bytea,selected_storage text,
  file_key_version smallint,file_key_nonce bytea,wrapped_file_key bytea,file_key_tag bytea,actor_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target app.onboarding_evidence_requests%ROWTYPE;
DECLARE created_id uuid;
BEGIN
  SELECT * INTO target FROM app.onboarding_evidence_requests WHERE id=target_request FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.accounts account JOIN app.portal_links link ON link.account_id=account.id
    WHERE account.id=actor_id AND account.kind='client' AND account.status='active'
      AND link.client_id=target.client_id AND link.ended_at IS NULL
      AND link.contact_id IS NOT DISTINCT FROM target.contact_id FOR SHARE OF account,link;
  IF NOT FOUND THEN RAISE EXCEPTION 'the evidence request is not available' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM 1 FROM app.aml_cdd_cases WHERE id=target.cdd_case_id AND client_id=target.client_id AND status='draft' FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM app.onboarding_evidence_submissions WHERE request_id=target.id) THEN
    RAISE EXCEPTION 'the evidence request is no longer open' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.aml_cdd_write','1',true);
  INSERT INTO app.aml_cdd_evidence(id,cdd_case_id,evidence_type,country,issued_on,expires_on,
    metadata_context,metadata_key_version,metadata_nonce,metadata_ciphertext,metadata_auth_tag,
    media_type,size_bytes,sha256,storage_key,file_key_version,file_key_nonce,wrapped_file_key,file_key_tag,uploaded_by)
  VALUES(target_evidence,target.cdd_case_id,target.evidence_type,target.country,NULL,NULL,
    metadata_context,metadata_key_version,metadata_nonce,metadata_ciphertext,metadata_tag,
    selected_media,selected_size,selected_hash,selected_storage,file_key_version,file_key_nonce,wrapped_file_key,file_key_tag,actor_id);
  INSERT INTO app.onboarding_evidence_submissions(request_id,evidence_id,uploaded_by)
    VALUES(target.id,target_evidence,actor_id) RETURNING id INTO created_id;
  PERFORM set_config('app.aml_cdd_write','0',true);
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.add_portal_aml_evidence(uuid,uuid,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_portal_aml_evidence(uuid,uuid,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;
