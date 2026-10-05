-- Clearing a possible conflict (docs/matters.md, step 8c). The supervising
-- partner records why the possible matches are not a conflict; that record is
-- the only way a matter moves from awaiting_clearance to open. The reason is
-- kept here, not in the audit log, because free text can hold personal data.
CREATE TABLE app.conflict_clearances (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id  uuid        NOT NULL REFERENCES app.matters (id),
  cleared_by uuid        NOT NULL REFERENCES app.accounts (id),
  reason     text        NOT NULL,
  cleared_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conflict_clearances_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT conflict_clearances_reason_safe CHECK (app.is_safe_text(reason))
);

CREATE UNIQUE INDEX conflict_clearances_one_per_matter ON app.conflict_clearances (matter_id);

REVOKE INSERT ON app.conflict_clearances FROM pms_app;
GRANT INSERT (matter_id, cleared_by, reason) ON app.conflict_clearances TO pms_app;

-- The app has no UPDATE right on matters, so recording a clearance is what
-- opens the matter. The rules are checked here, where no bug in the app can
-- skip them. SECURITY DEFINER runs this as the table owner, with a fixed
-- search_path so a caller cannot substitute their own tables or functions.
CREATE FUNCTION app.apply_conflict_clearance() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM app.matters WHERE id = NEW.matter_id FOR UPDATE;
  IF current_status IS DISTINCT FROM 'awaiting_clearance' THEN
    RAISE EXCEPTION 'matter % is not awaiting conflict clearance', NEW.matter_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.matter_team t
    JOIN app.accounts a ON a.id = t.account_id
    WHERE t.matter_id = NEW.matter_id
      AND t.account_id = NEW.cleared_by
      AND t.role = 'supervising_partner'
      AND t.removed_at IS NULL
      AND a.status = 'active'
      AND EXISTS (
        SELECT 1 FROM app.account_roles r
        WHERE r.account_id = NEW.cleared_by AND r.role = 'partner' AND r.revoked_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'a conflict is cleared only by the matter''s active supervising partner'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.matters SET status = 'open' WHERE id = NEW.matter_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_conflict_clearance() FROM PUBLIC;

CREATE TRIGGER conflict_clearances_apply
  BEFORE INSERT ON app.conflict_clearances
  FOR EACH ROW EXECUTE FUNCTION app.apply_conflict_clearance();

-- A recorded clearance stays as it was, for every role.
CREATE FUNCTION app.refuse_conflict_clearance_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'conflict clearances cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER conflict_clearances_fixed
  BEFORE UPDATE OR DELETE ON app.conflict_clearances
  FOR EACH ROW EXECUTE FUNCTION app.refuse_conflict_clearance_edit();
