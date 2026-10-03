CREATE TABLE app.password_resets (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid        NOT NULL REFERENCES app.accounts (id),
  token_hash   bytea       NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  requested_ip inet,
  closed_at    timestamptz,
  close_reason text,

  CONSTRAINT password_resets_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_resets_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT password_resets_close_complete CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CONSTRAINT password_resets_close_reason_valid CHECK (close_reason IN ('used', 'replaced'))
);

CREATE UNIQUE INDEX password_resets_token_hash_key ON app.password_resets (token_hash);
CREATE UNIQUE INDEX password_resets_one_open_per_account ON app.password_resets (account_id) WHERE closed_at IS NULL;
CREATE INDEX password_resets_recent_idx ON app.password_resets (account_id, created_at);

CREATE FUNCTION app.enforce_password_reset_closed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'password reset % is closed and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER password_resets_closed_once
  BEFORE UPDATE ON app.password_resets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_password_reset_closed_once();

GRANT UPDATE (closed_at, close_reason) ON app.password_resets TO pms_app;
