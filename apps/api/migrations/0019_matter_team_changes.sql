-- Team changes (docs/matters.md, step 8d). Removing someone closes their
-- membership row; the row is never deleted, so who could see a matter and
-- when stays answerable.
GRANT UPDATE (removed_at, removed_by) ON app.matter_team TO pms_app;

-- Only a removal can be recorded, once. A removed membership stays removed,
-- for every role; someone re-added gets a new row.
CREATE FUNCTION app.enforce_matter_team_removal_once() RETURNS trigger
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_team_removal_once
  BEFORE UPDATE ON app.matter_team
  FOR EACH ROW EXECUTE FUNCTION app.enforce_matter_team_removal_once();

-- Ending the supervising partner's membership is allowed only when another
-- supervising partner takes over in the same transaction: checked when it
-- commits, so a matter is never left without one.
CREATE FUNCTION app.enforce_matter_keeps_supervisor() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'supervising_partner' AND NOT EXISTS (
    SELECT 1 FROM app.matter_team
    WHERE matter_id = OLD.matter_id AND role = 'supervising_partner' AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'matter % would have no supervising partner', OLD.matter_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER matter_team_keeps_supervisor
  AFTER UPDATE ON app.matter_team
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_matter_keeps_supervisor();
