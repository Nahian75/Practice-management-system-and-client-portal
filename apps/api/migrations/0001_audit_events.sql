CREATE TABLE app.audit_events (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type    text        NOT NULL,
  actor_id      uuid,
  action        text        NOT NULL,
  outcome       text        NOT NULL,
  resource_type text,
  resource_id   text,
  ip_address    inet,
  user_agent    text,
  metadata      jsonb       NOT NULL DEFAULT '{}',

  CONSTRAINT audit_events_actor_type_valid
    CHECK (actor_type IN ('user', 'client', 'system', 'anonymous')),
  CONSTRAINT audit_events_actor_id_matches_type
    CHECK ((actor_type IN ('user', 'client')) = (actor_id IS NOT NULL)),
  CONSTRAINT audit_events_action_format
    CHECK (action ~ '^[a-z]+(\.[a-z]+(_[a-z]+)*)+$' AND length(action) <= 100),
  CONSTRAINT audit_events_outcome_valid
    CHECK (outcome IN ('success', 'denied', 'failure')),
  CONSTRAINT audit_events_resource_complete
    CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
  CONSTRAINT audit_events_resource_type_format
    CHECK (resource_type ~ '^[a-z]+(_[a-z]+)*$' AND length(resource_type) <= 50),
  CONSTRAINT audit_events_resource_id_length
    CHECK (length(resource_id) <= 100),
  CONSTRAINT audit_events_user_agent_length
    CHECK (length(user_agent) <= 512),
  CONSTRAINT audit_events_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_events_metadata_size
    CHECK (octet_length(metadata::text) <= 4096)
);

CREATE INDEX audit_events_occurred_at_idx ON app.audit_events (occurred_at);
CREATE INDEX audit_events_actor_idx ON app.audit_events (actor_id, occurred_at) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_events_resource_idx ON app.audit_events (resource_type, resource_id, occurred_at)
  WHERE resource_type IS NOT NULL;

-- Append-only, for every role including the table owner.
CREATE FUNCTION app.reject_audit_event_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_event_change();

CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_event_change();

-- The app may only supply the descriptive columns. id and occurred_at always
-- come from the database, so entries cannot be backdated or given chosen IDs.
REVOKE INSERT ON app.audit_events FROM pms_app;
GRANT INSERT (actor_type, actor_id, action, outcome, resource_type, resource_id, ip_address, user_agent, metadata)
  ON app.audit_events TO pms_app;
