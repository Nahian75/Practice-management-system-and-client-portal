-- The first tasks migration checks state during the insert. Lock those exact
-- rows too, so a closure, team removal or account disable arriving at the
-- same time is ordered before or after creation rather than slipping through
-- its check.
CREATE OR REPLACE FUNCTION app.check_new_task() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
  FROM app.matters m
  WHERE m.id = NEW.matter_id AND m.status = 'open'
  FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tasks are created only on open matters'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.matter_team t
  JOIN app.accounts a ON a.id = t.account_id
  WHERE t.matter_id = NEW.matter_id
    AND t.account_id = NEW.created_by
    AND t.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF t, a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tasks are created only by active matter team members'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.matter_team t
  JOIN app.accounts a ON a.id = t.account_id
  WHERE t.matter_id = NEW.matter_id
    AND t.account_id = NEW.assigned_to
    AND t.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF t, a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a task assignee must be an active matter team member'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_new_task() FROM PUBLIC;
