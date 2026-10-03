-- One authenticator-app secret per account, stored encrypted (AES-256-GCM).
-- The key is never in the database, so a copy of this table alone cannot
-- produce valid codes.
CREATE TABLE app.totp_credentials (
  account_id     uuid        PRIMARY KEY REFERENCES app.accounts (id),
  key_version    smallint    NOT NULL,
  nonce          bytea       NOT NULL,
  ciphertext     bytea       NOT NULL,
  auth_tag       bytea       NOT NULL,
  created_at     timestamptz NOT NULL,
  confirmed_at   timestamptz,
  last_used_step bigint,

  CONSTRAINT totp_credentials_key_version_positive CHECK (key_version > 0),
  CONSTRAINT totp_credentials_nonce_length CHECK (octet_length(nonce) = 12),
  CONSTRAINT totp_credentials_secret_length CHECK (octet_length(ciphertext) = 20),
  CONSTRAINT totp_credentials_tag_length CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT totp_credentials_used_only_when_confirmed
    CHECK (last_used_step IS NULL OR confirmed_at IS NOT NULL)
);

-- A code's time step may only move forward, so a used code can never be
-- accepted again. Replacing the secret (re-enrolment) starts a new sequence.
CREATE FUNCTION app.enforce_totp_step_forward() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ciphertext = OLD.ciphertext
     AND OLD.last_used_step IS NOT NULL
     AND (NEW.last_used_step IS NULL OR NEW.last_used_step <= OLD.last_used_step) THEN
    RAISE EXCEPTION 'TOTP time step for account % can only move forward', OLD.account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER totp_credentials_step_forward
  BEFORE UPDATE ON app.totp_credentials
  FOR EACH ROW EXECUTE FUNCTION app.enforce_totp_step_forward();

-- account_id never changes: a secret cannot be moved to another account.
GRANT UPDATE (key_version, nonce, ciphertext, auth_tag, created_at, confirmed_at, last_used_step)
  ON app.totp_credentials TO pms_app;
