-- Persistent encrypted email queue (docs/notifications.md, step 13a). The
-- application stores only ciphertext here; PostgreSQL owns delivery state.
CREATE TABLE app.email_outbox (
  id                   uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind                 text        NOT NULL,
  recipient_account_id uuid        REFERENCES app.accounts (id),
  resource_type        text,
  resource_id          uuid,
  deduplication_key    text        UNIQUE,
  key_version          integer,
  nonce                bytea,
  ciphertext           bytea,
  auth_tag             bytea,
  status               text        NOT NULL DEFAULT 'pending',
  queued_at            timestamptz NOT NULL DEFAULT statement_timestamp(),
  not_before           timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at           timestamptz NOT NULL DEFAULT statement_timestamp() + interval '24 hours',
  discard_after        timestamptz,
  attempt_count        integer     NOT NULL DEFAULT 0,
  lease_id             uuid,
  leased_until         timestamptz,
  completed_at         timestamptz,
  failure_class        text,

  CONSTRAINT email_outbox_kind_valid CHECK (
    kind IN ('account_invitation', 'password_reset', 'security_notice')
  ),
  CONSTRAINT email_outbox_resource_shape CHECK (
    (resource_type IS NULL) = (resource_id IS NULL)
    AND (resource_type IS NULL OR length(resource_type) BETWEEN 1 AND 50)
  ),
  CONSTRAINT email_outbox_deduplication_key_valid CHECK (
    deduplication_key IS NULL
    OR (length(deduplication_key) BETWEEN 1 AND 200 AND app.is_safe_text(deduplication_key))
  ),
  CONSTRAINT email_outbox_status_valid CHECK (status IN ('pending', 'sent', 'discarded', 'failed')),
  CONSTRAINT email_outbox_times_valid CHECK (
    expires_at = queued_at + interval '24 hours'
    AND not_before <= expires_at
    AND (discard_after IS NULL OR discard_after BETWEEN queued_at AND expires_at)
  ),
  CONSTRAINT email_outbox_attempt_count_valid CHECK (attempt_count >= 0),
  CONSTRAINT email_outbox_lease_shape CHECK ((lease_id IS NULL) = (leased_until IS NULL)),
  CONSTRAINT email_outbox_state_shape CHECK (
    (status = 'pending'
      AND completed_at IS NULL
      AND key_version >= 1
      AND octet_length(nonce) = 12
      AND octet_length(ciphertext) >= 1
      AND octet_length(auth_tag) = 16
      AND (failure_class IS NULL OR failure_class = 'temporary'))
    OR
    (status IN ('sent', 'discarded', 'failed')
      AND completed_at IS NOT NULL
      AND lease_id IS NULL AND leased_until IS NULL
      AND key_version IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL
      AND (
        (status IN ('sent', 'discarded') AND failure_class IS NULL)
        OR
        (status = 'failed' AND failure_class IN (
          'malformed', 'invalid_payload', 'provider_rejected', 'delivery_expired'
        ))
      ))
  )
);

CREATE INDEX email_outbox_due_idx
  ON app.email_outbox (not_before, queued_at)
  WHERE status = 'pending';

REVOKE INSERT ON app.email_outbox FROM pms_app;
GRANT INSERT (
  kind, recipient_account_id, resource_type, resource_id, deduplication_key,
  key_version, nonce, ciphertext, auth_tag, not_before, discard_after
) ON app.email_outbox TO pms_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app.email_outbox FROM pms_app;

-- Claims and outcomes form an immutable record. Its trigger is the only path
-- that may change the queue row, so direct edits remain blocked for the owner.
CREATE TABLE app.email_outbox_changes (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  email_outbox_id uuid        NOT NULL REFERENCES app.email_outbox (id),
  action          text        NOT NULL,
  lease_id        uuid        NOT NULL,
  retry_seconds   integer,
  failure_class   text,
  changed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT email_outbox_changes_action_valid CHECK (
    action IN ('claimed', 'retry', 'sent', 'discarded', 'failed')
  ),
  CONSTRAINT email_outbox_changes_shape_valid CHECK (
    (action = 'claimed' AND retry_seconds IS NULL AND failure_class IS NULL)
    OR
    (action = 'retry' AND retry_seconds BETWEEN 1 AND 21600 AND failure_class = 'temporary')
    OR
    (action IN ('sent', 'discarded') AND retry_seconds IS NULL AND failure_class IS NULL)
    OR
    (action = 'failed' AND retry_seconds IS NULL AND failure_class IN (
      'malformed', 'invalid_payload', 'provider_rejected', 'delivery_expired'
    ))
  )
);

CREATE INDEX email_outbox_changes_outbox_idx
  ON app.email_outbox_changes (email_outbox_id, changed_at, id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.email_outbox_changes FROM pms_app;

CREATE FUNCTION app.refuse_email_outbox_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
      OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
      OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key
      OR NEW.queued_at IS DISTINCT FROM OLD.queued_at
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.discard_after IS DISTINCT FROM OLD.discard_after
    THEN
      RAISE EXCEPTION 'an email outbox row''s identity and message record are fixed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'email outbox rows cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_email_outbox_edit() FROM PUBLIC;

CREATE TRIGGER email_outbox_fixed
  BEFORE UPDATE OR DELETE ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.refuse_email_outbox_edit();

CREATE TRIGGER email_outbox_no_truncate
  BEFORE TRUNCATE ON app.email_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_email_outbox_edit();

CREATE FUNCTION app.refuse_email_outbox_change_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email outbox changes cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_email_outbox_change_edit() FROM PUBLIC;

CREATE TRIGGER email_outbox_changes_fixed
  BEFORE UPDATE OR DELETE ON app.email_outbox_changes
  FOR EACH ROW EXECUTE FUNCTION app.refuse_email_outbox_change_edit();

CREATE TRIGGER email_outbox_changes_no_truncate
  BEFORE TRUNCATE ON app.email_outbox_changes
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_email_outbox_change_edit();

CREATE FUNCTION app.apply_email_outbox_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_row app.email_outbox%ROWTYPE;
BEGIN
  SELECT * INTO current_row
  FROM app.email_outbox
  WHERE id = NEW.email_outbox_id
  FOR UPDATE;

  IF NOT FOUND OR current_row.status <> 'pending' THEN
    RETURN NULL;
  END IF;

  IF NEW.action = 'claimed' THEN
    IF current_row.not_before > clock_timestamp()
      OR (current_row.lease_id IS NOT NULL AND current_row.leased_until > clock_timestamp())
    THEN
      RETURN NULL;
    END IF;

    UPDATE app.email_outbox
    SET lease_id = NEW.lease_id,
        leased_until = clock_timestamp() + interval '30 seconds',
        attempt_count = attempt_count + 1
    WHERE id = NEW.email_outbox_id;
    RETURN NEW;
  END IF;

  IF current_row.lease_id IS DISTINCT FROM NEW.lease_id THEN
    RETURN NULL;
  END IF;

  IF NEW.action = 'retry' THEN
    UPDATE app.email_outbox
    SET lease_id = NULL,
        leased_until = NULL,
        not_before = least(
          clock_timestamp() + make_interval(secs => NEW.retry_seconds),
          expires_at
        ),
        failure_class = NEW.failure_class
    WHERE id = NEW.email_outbox_id;
  ELSE
    UPDATE app.email_outbox
    SET status = NEW.action,
        lease_id = NULL,
        leased_until = NULL,
        key_version = NULL,
        nonce = NULL,
        ciphertext = NULL,
        auth_tag = NULL,
        completed_at = clock_timestamp(),
        failure_class = NEW.failure_class
    WHERE id = NEW.email_outbox_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_email_outbox_change() FROM PUBLIC;

CREATE TRIGGER email_outbox_changes_apply
  BEFORE INSERT ON app.email_outbox_changes
  FOR EACH ROW EXECUTE FUNCTION app.apply_email_outbox_change();

CREATE FUNCTION app.claim_email_outbox() RETURNS SETOF app.email_outbox
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  outbox_id uuid;
  new_lease uuid := uuidv7();
BEGIN
  SELECT id INTO outbox_id
  FROM app.email_outbox
  WHERE status = 'pending'
    AND not_before <= clock_timestamp()
    AND (lease_id IS NULL OR leased_until <= clock_timestamp())
  ORDER BY not_before, queued_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF outbox_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO app.email_outbox_changes (email_outbox_id, action, lease_id)
  VALUES (outbox_id, 'claimed', new_lease);

  RETURN QUERY SELECT * FROM app.email_outbox WHERE id = outbox_id;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_email_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_email_outbox() TO pms_app;

CREATE FUNCTION app.finish_email_outbox(
  outbox_id uuid,
  current_lease uuid,
  outcome text,
  retry_after_seconds integer,
  safe_failure_class text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO app.email_outbox_changes (
    email_outbox_id, action, lease_id, retry_seconds, failure_class
  ) VALUES (
    outbox_id, outcome, current_lease, retry_after_seconds, safe_failure_class
  );
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION app.finish_email_outbox(uuid, uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finish_email_outbox(uuid, uuid, text, integer, text) TO pms_app;
