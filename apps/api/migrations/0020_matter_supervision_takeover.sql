-- Taking over supervision (docs/matters.md, step 8e). When a matter's
-- supervising partner can no longer act (account not active, or no partner
-- role), another partner takes over, giving a reason. Recording the takeover
-- is what changes the team: the rules are checked here, where no bug in the
-- app can skip them. The reason is kept here, not in the audit log.
CREATE TABLE app.matter_supervision_takeovers (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id       uuid        NOT NULL REFERENCES app.matters (id),
  from_account_id uuid        NOT NULL REFERENCES app.accounts (id),
  to_account_id   uuid        NOT NULL REFERENCES app.accounts (id),
  reason          text        NOT NULL,
  taken_at        timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT matter_supervision_takeovers_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT matter_supervision_takeovers_reason_safe CHECK (app.is_safe_text(reason)),
  CONSTRAINT matter_supervision_takeovers_to_someone_else CHECK (from_account_id <> to_account_id)
);

CREATE INDEX matter_supervision_takeovers_matter_idx ON app.matter_supervision_takeovers (matter_id);

REVOKE INSERT ON app.matter_supervision_takeovers FROM pms_app;
GRANT INSERT (matter_id, from_account_id, to_account_id, reason) ON app.matter_supervision_takeovers TO pms_app;

-- SECURITY DEFINER runs this as the table owner, with a fixed search_path so
-- a caller cannot substitute their own tables or functions.
CREATE FUNCTION app.apply_supervision_takeover() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  supervision_id uuid;
  supervisor_id uuid;
BEGIN
  SELECT id, account_id INTO supervision_id, supervisor_id
  FROM app.matter_team
  WHERE matter_id = NEW.matter_id AND role = 'supervising_partner' AND removed_at IS NULL
  FOR UPDATE;
  IF supervisor_id IS DISTINCT FROM NEW.from_account_id THEN
    RAISE EXCEPTION 'matter % is not supervised by %', NEW.matter_id, NEW.from_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.accounts WHERE id = supervisor_id AND status = 'active')
     AND EXISTS (SELECT 1 FROM app.account_roles WHERE account_id = supervisor_id AND role = 'partner' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'supervision is taken over only from a partner who can no longer act'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.to_account_id AND kind = 'staff' AND status = 'active')
     OR NOT EXISTS (SELECT 1 FROM app.account_roles WHERE account_id = NEW.to_account_id AND role = 'partner' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'supervision is taken over by an active partner'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.matter_team SET removed_at = clock_timestamp(), removed_by = NEW.to_account_id
  WHERE id = supervision_id;
  UPDATE app.matter_team SET removed_at = clock_timestamp(), removed_by = NEW.to_account_id
  WHERE matter_id = NEW.matter_id AND account_id = NEW.to_account_id AND removed_at IS NULL;
  INSERT INTO app.matter_team (matter_id, account_id, role, added_by)
  VALUES (NEW.matter_id, NEW.to_account_id, 'supervising_partner', NEW.to_account_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_supervision_takeover() FROM PUBLIC;

CREATE TRIGGER matter_supervision_takeovers_apply
  BEFORE INSERT ON app.matter_supervision_takeovers
  FOR EACH ROW EXECUTE FUNCTION app.apply_supervision_takeover();

-- A recorded takeover stays as it was, for every role.
CREATE FUNCTION app.refuse_supervision_takeover_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'supervision takeovers cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER matter_supervision_takeovers_fixed
  BEFORE UPDATE OR DELETE ON app.matter_supervision_takeovers
  FOR EACH ROW EXECUTE FUNCTION app.refuse_supervision_takeover_edit();
