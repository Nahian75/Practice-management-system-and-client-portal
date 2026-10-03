CREATE TABLE app.accounts (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind                text        NOT NULL,
  email               text        NOT NULL,
  display_name        text        NOT NULL,
  status              text        NOT NULL DEFAULT 'invited',
  password_hash       text,
  password_changed_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT accounts_kind_valid
    CHECK (kind IN ('staff', 'client')),
  CONSTRAINT accounts_email_normalised
    CHECK (email = lower(email) AND email = btrim(email)),
  CONSTRAINT accounts_email_format
    CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT accounts_display_name_length
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  CONSTRAINT accounts_status_valid
    CHECK (status IN ('invited', 'active', 'disabled')),
  CONSTRAINT accounts_active_has_password
    CHECK (status <> 'active' OR password_hash IS NOT NULL),
  CONSTRAINT accounts_password_hash_format
    CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'),
  CONSTRAINT accounts_password_fields_together
    CHECK ((password_hash IS NULL) = (password_changed_at IS NULL))
);

CREATE UNIQUE INDEX accounts_email_key ON app.accounts (email);

-- Accounts are disabled, never deleted, so the audit trail always resolves.
-- kind, email and id cannot be changed by the app: a client account can never
-- become a staff account, and an account cannot be moved to another address.
GRANT UPDATE (display_name, status, password_hash, password_changed_at)
  ON app.accounts TO pms_app;
