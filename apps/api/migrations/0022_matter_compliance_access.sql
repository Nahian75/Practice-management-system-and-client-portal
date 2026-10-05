-- Compliance access with a reason (docs/matters.md, step 8g). Decided by the
-- project owner: compliance can open a matter they are not on only by
-- recording a reason, which is audited and visible to the matter's
-- supervising partner. Each look is a new row; there is no lasting access.
CREATE TABLE app.matter_compliance_accesses (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id   uuid        NOT NULL REFERENCES app.matters (id),
  accessed_by uuid        NOT NULL REFERENCES app.accounts (id),
  reason      text        NOT NULL,
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT matter_compliance_accesses_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT matter_compliance_accesses_reason_safe CHECK (app.is_safe_text(reason))
);

CREATE INDEX matter_compliance_accesses_matter_idx ON app.matter_compliance_accesses (matter_id, accessed_at);

REVOKE INSERT ON app.matter_compliance_accesses FROM pms_app;
GRANT INSERT (matter_id, accessed_by, reason) ON app.matter_compliance_accesses TO pms_app;

-- Only an active account holding the compliance role can record an access.
CREATE FUNCTION app.enforce_compliance_accessor() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.accessed_by AND kind = 'staff' AND status = 'active')
     OR NOT EXISTS (
       SELECT 1 FROM app.account_roles WHERE account_id = NEW.accessed_by AND role = 'compliance' AND revoked_at IS NULL
     ) THEN
    RAISE EXCEPTION 'matters are accessed with a reason only by active compliance staff'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_compliance_accesses_accessor
  BEFORE INSERT ON app.matter_compliance_accesses
  FOR EACH ROW EXECUTE FUNCTION app.enforce_compliance_accessor();

-- A recorded access stays as it was, for every role.
CREATE FUNCTION app.refuse_compliance_access_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance accesses cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER matter_compliance_accesses_fixed
  BEFORE UPDATE OR DELETE ON app.matter_compliance_accesses
  FOR EACH ROW EXECUTE FUNCTION app.refuse_compliance_access_edit();
