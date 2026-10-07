-- Review T1: a matter's recorded supervisor may remain on the team after
-- losing the partner role, until another partner takes over. That stale team
-- label must not keep the supervisor-only power to change task status.
CREATE FUNCTION app.require_current_task_status_actor() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  matter           uuid;
  current_assignee uuid;
BEGIN
  IF NEW.kind <> 'status' THEN
    RETURN NEW;
  END IF;

  SELECT matter_id INTO matter FROM app.tasks WHERE id = NEW.task_id;
  IF matter IS NULL THEN
    RETURN NEW;
  END IF;

  -- Use the same lock order as apply_task_change: matter, task, team,
  -- account, role. A role removal and a status change are therefore ordered.
  PERFORM 1 FROM app.matters WHERE id = matter FOR SHARE;
  SELECT assigned_to INTO current_assignee
  FROM app.tasks
  WHERE id = NEW.task_id
  FOR UPDATE;

  IF NEW.changed_by = current_assignee THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM app.matter_team t
  JOIN app.accounts a ON a.id = t.account_id
  JOIN app.account_roles r ON r.account_id = t.account_id
  WHERE t.matter_id = matter
    AND t.account_id = NEW.changed_by
    AND t.role = 'supervising_partner'
    AND t.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
    AND r.role = 'partner'
    AND r.revoked_at IS NULL
  FOR SHARE OF t, a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task status is changed only by its assignee or active supervising partner'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.require_current_task_status_actor() FROM PUBLIC;

-- PostgreSQL runs triggers with the same timing alphabetically. "actor"
-- comes before "apply", so the current-role check takes its locks first.
CREATE TRIGGER task_changes_actor_role
  BEFORE INSERT ON app.task_changes
  FOR EACH ROW EXECUTE FUNCTION app.require_current_task_status_actor();
