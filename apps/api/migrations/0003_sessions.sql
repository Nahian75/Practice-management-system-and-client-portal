CREATE TABLE app.sessions (
  id               uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id       uuid        NOT NULL REFERENCES app.accounts (id),
  token_hash       bytea       NOT NULL,
  stage            text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  authenticated_at timestamptz,
  last_seen_at     timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  end_reason       text,
  ip_address       inet,
  user_agent       text,

  CONSTRAINT sessions_token_hash_length
    CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_stage_valid
    CHECK (stage IN ('two_factor_pending', 'authenticated')),
  CONSTRAINT sessions_authenticated_at_matches_stage
    CHECK ((stage = 'authenticated') = (authenticated_at IS NOT NULL)),
  CONSTRAINT sessions_end_complete
    CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT sessions_end_reason_valid
    CHECK (end_reason IN ('signed_out', 'expired', 'revoked')),
  CONSTRAINT sessions_user_agent_length
    CHECK (length(user_agent) <= 512)
);

CREATE UNIQUE INDEX sessions_token_hash_key ON app.sessions (token_hash);
CREATE INDEX sessions_open_by_account_idx ON app.sessions (account_id) WHERE ended_at IS NULL;

-- A session only moves forward: pending → authenticated → ended.
-- An ended session can never be reopened, even by the table owner.
CREATE FUNCTION app.enforce_session_transitions() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'session % has ended and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.stage = 'authenticated' AND NEW.stage <> 'authenticated' THEN
    RAISE EXCEPTION 'session % cannot return to an earlier stage', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_enforce_transitions
  BEFORE UPDATE ON app.sessions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_session_transitions();

-- created_at and id come from the database. A session is never created already ended.
REVOKE INSERT ON app.sessions FROM pms_app;
GRANT INSERT (account_id, token_hash, stage, authenticated_at, last_seen_at, expires_at, ip_address, user_agent)
  ON app.sessions TO pms_app;
-- account_id and token_hash never change: a session cannot be moved to another account.
GRANT UPDATE (stage, authenticated_at, last_seen_at, expires_at, ended_at, end_reason)
  ON app.sessions TO pms_app;
