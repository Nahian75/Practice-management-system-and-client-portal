-- Wrong 2FA codes are recorded alongside wrong passwords: they count towards
-- the same account block, and towards a per-attempt limit on their session.
ALTER TABLE app.sign_in_failures ADD COLUMN session_id uuid REFERENCES app.sessions (id);

ALTER TABLE app.sign_in_failures DROP CONSTRAINT sign_in_failures_reason_valid;
ALTER TABLE app.sign_in_failures ADD CONSTRAINT sign_in_failures_reason_valid
  CHECK (reason IN ('unknown_account', 'wrong_password', 'account_not_active', 'wrong_two_factor_code'));
ALTER TABLE app.sign_in_failures ADD CONSTRAINT sign_in_failures_session_matches_reason
  CHECK ((reason = 'wrong_two_factor_code') = (session_id IS NOT NULL));

CREATE INDEX sign_in_failures_session_idx ON app.sign_in_failures (session_id) WHERE session_id IS NOT NULL;

-- A 2FA-pending session is ended and replaced by a new one when the code is
-- accepted, so the token seen during sign-in never becomes a working session.
ALTER TABLE app.sessions DROP CONSTRAINT sessions_end_reason_valid;
ALTER TABLE app.sessions ADD CONSTRAINT sessions_end_reason_valid
  CHECK (end_reason IN ('signed_out', 'expired', 'revoked', 'replaced'));

CREATE TABLE app.backup_codes (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id   uuid        NOT NULL REFERENCES app.accounts (id),
  code_hash    bytea       NOT NULL,
  created_at   timestamptz NOT NULL,
  spent_at     timestamptz,
  spent_reason text,

  CONSTRAINT backup_codes_hash_length CHECK (octet_length(code_hash) = 32),
  CONSTRAINT backup_codes_spent_complete CHECK ((spent_at IS NULL) = (spent_reason IS NULL)),
  CONSTRAINT backup_codes_spent_reason_valid CHECK (spent_reason IN ('used', 'replaced'))
);

CREATE INDEX backup_codes_unspent_idx ON app.backup_codes (account_id, code_hash) WHERE spent_at IS NULL;

-- Once spent, a backup code can never be made usable again, even by the owner.
CREATE FUNCTION app.enforce_backup_code_spent_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.spent_at IS NOT NULL THEN
    RAISE EXCEPTION 'backup code % is already spent', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER backup_codes_spent_once
  BEFORE UPDATE ON app.backup_codes
  FOR EACH ROW EXECUTE FUNCTION app.enforce_backup_code_spent_once();

GRANT UPDATE (spent_at, spent_reason) ON app.backup_codes TO pms_app;
