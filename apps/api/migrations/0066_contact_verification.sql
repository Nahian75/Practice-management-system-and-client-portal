-- Client onboarding addendum 17b-1: one-time email contact verification.

ALTER TABLE app.email_outbox DROP CONSTRAINT email_outbox_kind_valid;
ALTER TABLE app.email_outbox ADD CONSTRAINT email_outbox_kind_valid CHECK (
  kind IN ('account_invitation', 'password_reset', 'security_notice',
    'contact_verification', 'task_assignment', 'task_reminder')
);

CREATE TABLE app.contact_verification_requests (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id     uuid        NOT NULL REFERENCES app.clients(id),
  contact_id    uuid        REFERENCES app.client_contacts(id),
  channel       text        NOT NULL DEFAULT 'email',
  address       text        NOT NULL,
  token_hash    bytea       NOT NULL UNIQUE,
  requested_by  uuid        NOT NULL REFERENCES app.accounts(id),
  requested_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at    timestamptz NOT NULL,
  verified_at   timestamptz,

  CONSTRAINT contact_verification_channel_valid CHECK (channel = 'email'),
  CONSTRAINT contact_verification_address_safe CHECK (
    app.is_safe_text(address) AND length(address) BETWEEN 3 AND 320
  ),
  CONSTRAINT contact_verification_hash_valid CHECK (octet_length(token_hash) = 32),
  CONSTRAINT contact_verification_time_valid CHECK (
    expires_at > requested_at AND expires_at <= requested_at + interval '24 hours'
    AND (verified_at IS NULL OR verified_at >= requested_at)
  )
);
CREATE INDEX contact_verification_subject_idx
  ON app.contact_verification_requests (client_id, contact_id, requested_at DESC, id DESC);
CREATE INDEX contact_verification_actor_idx
  ON app.contact_verification_requests (requested_by, requested_at DESC);

CREATE TABLE app.contact_verification_attempts (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  request_id    uuid        NOT NULL REFERENCES app.contact_verification_requests(id),
  outcome       text        NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT contact_verification_attempt_outcome_valid CHECK (
    outcome IN ('verified', 'expired', 'superseded', 'address_changed', 'already_verified')
  )
);
CREATE INDEX contact_verification_attempt_request_idx
  ON app.contact_verification_attempts (request_id, attempted_at DESC, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.contact_verification_requests, app.contact_verification_attempts FROM pms_app;

CREATE FUNCTION app.protect_contact_verification_request() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.contact_verification_complete', true) <> '1'
      OR OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL
      OR NEW.id <> OLD.id OR NEW.client_id <> OLD.client_id
      OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.channel <> OLD.channel
      OR NEW.address <> OLD.address OR NEW.token_hash <> OLD.token_hash
      OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at
      OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'contact verification requests are fixed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_contact_verification_request() FROM PUBLIC;
CREATE TRIGGER contact_verification_requests_fixed
  BEFORE UPDATE OR DELETE ON app.contact_verification_requests
  FOR EACH ROW EXECUTE FUNCTION app.protect_contact_verification_request();
CREATE TRIGGER contact_verification_attempts_fixed
  BEFORE UPDATE OR DELETE ON app.contact_verification_attempts
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER contact_verification_requests_no_truncate
  BEFORE TRUNCATE ON app.contact_verification_requests
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER contact_verification_attempts_no_truncate
  BEFORE TRUNCATE ON app.contact_verification_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();

CREATE FUNCTION app.request_contact_email_verification(
  target_client uuid, target_contact uuid, selected_token_hash bytea, actor_id uuid
) RETURNS TABLE(id uuid, address text, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE selected_address text;
DECLARE created_id uuid;
DECLARE created_expiry timestamptz;
BEGIN
  PERFORM app.assert_aml_client_access(actor_id, target_client);
  IF (SELECT kind FROM app.clients WHERE app.clients.id = target_client) = 'individual' THEN
    IF target_contact IS NOT NULL THEN
      RAISE EXCEPTION 'an individual client has no organisation contact' USING ERRCODE = 'check_violation';
    END IF;
    SELECT lower(btrim(email)) INTO selected_address
      FROM app.client_individuals WHERE client_id = target_client;
  ELSE
    IF target_contact IS NULL THEN
      RAISE EXCEPTION 'an organisation contact is required' USING ERRCODE = 'check_violation';
    END IF;
    SELECT lower(btrim(contact.email)) INTO selected_address FROM app.client_contacts contact
      WHERE contact.id = target_contact AND contact.client_id = target_client AND contact.active FOR SHARE;
  END IF;
  IF selected_address IS NULL OR selected_address = '' THEN
    RAISE EXCEPTION 'the selected person has no email address' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM app.contact_verification_requests
      WHERE requested_by = actor_id AND requested_at > clock_timestamp() - interval '1 hour') >= 20
    OR (SELECT count(*) FROM app.contact_verification_requests
      WHERE client_id = target_client AND requested_at > clock_timestamp() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'contact verification request limit reached' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  created_expiry := clock_timestamp() + interval '24 hours';
  INSERT INTO app.contact_verification_requests(client_id, contact_id, address, token_hash,
    requested_by, expires_at)
  VALUES(target_client, target_contact, selected_address, selected_token_hash, actor_id, created_expiry)
  RETURNING app.contact_verification_requests.id INTO created_id;
  RETURN QUERY SELECT created_id, selected_address, created_expiry;
END;
$$;
REVOKE ALL ON FUNCTION app.request_contact_email_verification(uuid, uuid, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_contact_email_verification(uuid, uuid, bytea, uuid) TO pms_app;

CREATE FUNCTION app.complete_contact_email_verification(selected_token_hash bytea)
RETURNS TABLE(outcome text, request_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.contact_verification_requests%ROWTYPE;
DECLARE current_address text;
DECLARE selected_outcome text;
BEGIN
  SELECT * INTO target FROM app.contact_verification_requests
    WHERE token_hash = selected_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF target.verified_at IS NOT NULL THEN
    selected_outcome := 'already_verified';
  ELSIF target.expires_at <= clock_timestamp() THEN
    selected_outcome := 'expired';
  ELSIF EXISTS (SELECT 1 FROM app.contact_verification_requests newer
      WHERE newer.client_id = target.client_id
        AND newer.contact_id IS NOT DISTINCT FROM target.contact_id
        AND (newer.requested_at, newer.id) > (target.requested_at, target.id)) THEN
    selected_outcome := 'superseded';
  ELSE
    IF target.contact_id IS NULL THEN
      SELECT lower(btrim(email)) INTO current_address FROM app.client_individuals
        WHERE client_id = target.client_id;
    ELSE
      SELECT lower(btrim(email)) INTO current_address FROM app.client_contacts
        WHERE id = target.contact_id AND client_id = target.client_id AND active;
    END IF;
    IF current_address IS DISTINCT FROM target.address THEN
      selected_outcome := 'address_changed';
    ELSE
      selected_outcome := 'verified';
      PERFORM set_config('app.contact_verification_complete', '1', true);
      UPDATE app.contact_verification_requests SET verified_at = clock_timestamp()
        WHERE id = target.id;
      PERFORM set_config('app.contact_verification_complete', '0', true);
    END IF;
  END IF;
  INSERT INTO app.contact_verification_attempts(request_id, outcome)
    VALUES(target.id, selected_outcome);
  RETURN QUERY SELECT selected_outcome, target.id;
END;
$$;
REVOKE ALL ON FUNCTION app.complete_contact_email_verification(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_contact_email_verification(bytea) TO pms_app;
