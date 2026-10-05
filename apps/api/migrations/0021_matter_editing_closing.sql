-- Editing and closing matters (docs/matters.md, step 8f).

-- The title and type can be corrected while the matter is not closed.
GRANT UPDATE (title, matter_type) ON app.matters TO pms_app;

-- A closed matter is final, for every role: no edits, and no status change.
CREATE FUNCTION app.refuse_closed_matter_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'matter % is closed and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matters_closed_fixed
  BEFORE UPDATE ON app.matters
  FOR EACH ROW EXECUTE FUNCTION app.refuse_closed_matter_change();

-- Nor can its team change. These replace the functions from 0016 and 0019,
-- adding the closed check; the rest is unchanged.
CREATE OR REPLACE FUNCTION app.enforce_matter_team_member() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allowed_roles text[] := CASE NEW.role
    WHEN 'supervising_partner' THEN ARRAY['partner']
    ELSE ARRAY['partner', 'fee_earner']
  END;
BEGIN
  IF (SELECT status FROM app.matters WHERE id = NEW.matter_id) = 'closed' THEN
    RAISE EXCEPTION 'matter % is closed and its team cannot change', NEW.matter_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.account_id AND kind = 'staff' AND status = 'active') THEN
    RAISE EXCEPTION 'matter team members are active staff accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles
    WHERE account_id = NEW.account_id AND revoked_at IS NULL AND role = ANY (allowed_roles)
  ) THEN
    RAISE EXCEPTION 'a % must hold a role that allows it', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_matter_team_removal_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'membership % is already ended and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'a membership change can only end it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT status FROM app.matters WHERE id = OLD.matter_id) = 'closed' THEN
    RAISE EXCEPTION 'matter % is closed and its team cannot change', OLD.matter_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Closing a matter: the supervising partner records why, and that record is
-- the only way a matter becomes closed. The reason is kept here, not in the
-- audit log. SECURITY DEFINER runs the change as the table owner, with a
-- fixed search_path.
CREATE TABLE app.matter_closures (
  id        uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id uuid        NOT NULL REFERENCES app.matters (id),
  closed_by uuid        NOT NULL REFERENCES app.accounts (id),
  reason    text        NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT matter_closures_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT matter_closures_reason_safe CHECK (app.is_safe_text(reason))
);

CREATE UNIQUE INDEX matter_closures_one_per_matter ON app.matter_closures (matter_id);

REVOKE INSERT ON app.matter_closures FROM pms_app;
GRANT INSERT (matter_id, closed_by, reason) ON app.matter_closures TO pms_app;

CREATE FUNCTION app.apply_matter_closure() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM 1 FROM app.matters WHERE id = NEW.matter_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM app.matter_team t
    JOIN app.accounts a ON a.id = t.account_id
    WHERE t.matter_id = NEW.matter_id
      AND t.account_id = NEW.closed_by
      AND t.role = 'supervising_partner'
      AND t.removed_at IS NULL
      AND a.status = 'active'
      AND EXISTS (
        SELECT 1 FROM app.account_roles r
        WHERE r.account_id = NEW.closed_by AND r.role = 'partner' AND r.revoked_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'a matter is closed only by its active supervising partner'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The closed-matter trigger refuses this when the matter is already closed.
  UPDATE app.matters SET status = 'closed' WHERE id = NEW.matter_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_matter_closure() FROM PUBLIC;

CREATE TRIGGER matter_closures_apply
  BEFORE INSERT ON app.matter_closures
  FOR EACH ROW EXECUTE FUNCTION app.apply_matter_closure();

CREATE FUNCTION app.refuse_matter_closure_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'matter closures cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER matter_closures_fixed
  BEFORE UPDATE OR DELETE ON app.matter_closures
  FOR EACH ROW EXECUTE FUNCTION app.refuse_matter_closure_edit();
