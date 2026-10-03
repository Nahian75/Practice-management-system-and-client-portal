CREATE TABLE app.invitations (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id    uuid        NOT NULL REFERENCES app.accounts (id),
  token_hash    bytea       NOT NULL,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_by    uuid        REFERENCES app.accounts (id),
  closed_at     timestamptz,
  close_reason  text,

  CONSTRAINT invitations_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT invitations_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT invitations_close_complete CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CONSTRAINT invitations_close_reason_valid CHECK (close_reason IN ('accepted', 'replaced'))
);

CREATE UNIQUE INDEX invitations_token_hash_key ON app.invitations (token_hash);

-- At most one open invitation per account: sending a new one closes the old.
CREATE UNIQUE INDEX invitations_one_open_per_account ON app.invitations (account_id) WHERE closed_at IS NULL;

-- A closed invitation stays closed, for every role.
CREATE FUNCTION app.enforce_invitation_closed_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation % is closed and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_closed_once
  BEFORE UPDATE ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_invitation_closed_once();

GRANT UPDATE (closed_at, close_reason) ON app.invitations TO pms_app;
