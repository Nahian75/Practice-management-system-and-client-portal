-- Which staff account holds which role, and when. Rows are never deleted:
-- revoking a role closes the row, so the history stays answerable.
CREATE TABLE app.account_roles (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid        NOT NULL REFERENCES app.accounts (id),
  role        text        NOT NULL,
  granted_at  timestamptz NOT NULL,
  granted_by  uuid        REFERENCES app.accounts (id),
  revoked_at  timestamptz,
  revoked_by  uuid        REFERENCES app.accounts (id),

  CONSTRAINT account_roles_role_valid
    CHECK (role IN ('administrator', 'partner', 'fee_earner', 'accounts', 'compliance')),
  CONSTRAINT account_roles_revoked_by_only_when_revoked
    CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL),
  CONSTRAINT account_roles_not_self_granted
    CHECK (granted_by IS DISTINCT FROM account_id),
  CONSTRAINT account_roles_not_self_revoked
    CHECK (revoked_by IS DISTINCT FROM account_id)
);

CREATE UNIQUE INDEX account_roles_one_active ON app.account_roles (account_id, role) WHERE revoked_at IS NULL;
CREATE INDEX account_roles_active_by_role ON app.account_roles (role) WHERE revoked_at IS NULL;

-- Only staff accounts hold roles. A cross-table rule, so a trigger rather than a CHECK.
CREATE FUNCTION app.enforce_role_holder_is_staff() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM app.accounts WHERE id = NEW.account_id) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'only staff accounts can hold roles'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_roles_holder_is_staff
  BEFORE INSERT ON app.account_roles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_role_holder_is_staff();

-- A revoked role stays revoked, for every role.
CREATE FUNCTION app.enforce_role_revoked_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role assignment % is revoked and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_roles_revoked_once
  BEFORE UPDATE ON app.account_roles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_role_revoked_once();

GRANT UPDATE (revoked_at, revoked_by) ON app.account_roles TO pms_app;
