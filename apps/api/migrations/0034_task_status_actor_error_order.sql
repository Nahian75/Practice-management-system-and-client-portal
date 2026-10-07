-- Keep the existing outside-team refusal distinct from review T1's new
-- former-supervisor refusal. Migration 0033 has already been applied, so this
-- migration replaces its function rather than rewriting it.
CREATE OR REPLACE FUNCTION app.require_current_task_status_actor() RETURNS trigger
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

  PERFORM 1 FROM app.matters WHERE id = matter FOR SHARE;
  SELECT assigned_to INTO current_assignee
  FROM app.tasks
  WHERE id = NEW.task_id
  FOR UPDATE;

  IF NEW.changed_by = current_assignee THEN
    RETURN NEW;
  END IF;

  -- Leave outsiders to apply_task_change, which gives the established
  -- active-team refusal. These locks also stop removal or disabling racing
  -- the current-partner check below.
  PERFORM 1
  FROM app.matter_team t
  JOIN app.accounts a ON a.id = t.account_id
  WHERE t.matter_id = matter
    AND t.account_id = NEW.changed_by
    AND t.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF t, a;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM app.matter_team t
  JOIN app.account_roles r ON r.account_id = t.account_id
  WHERE t.matter_id = matter
    AND t.account_id = NEW.changed_by
    AND t.role = 'supervising_partner'
    AND t.removed_at IS NULL
    AND r.role = 'partner'
    AND r.revoked_at IS NULL
  FOR SHARE OF t, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task status is changed only by its assignee or supervising partner with an active partner role'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.require_current_task_status_actor() FROM PUBLIC;
