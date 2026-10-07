-- Task changes are permanent records. They are the only route to changing a
-- task's current details, assignee or status (docs/tasks.md, step 12b).
CREATE TABLE app.task_changes (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  task_id            uuid        NOT NULL REFERENCES app.tasks (id),
  kind               text        NOT NULL,
  from_title         text,
  to_title           text,
  from_description   text,
  to_description     text,
  from_due_on        date,
  to_due_on          date,
  from_priority      text,
  to_priority        text,
  from_assigned_to   uuid        REFERENCES app.accounts (id),
  to_assigned_to     uuid        REFERENCES app.accounts (id),
  from_status        text,
  to_status          text,
  changed_by         uuid        NOT NULL REFERENCES app.accounts (id),
  changed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT task_changes_kind_valid CHECK (kind IN ('details', 'assignment', 'status')),
  CONSTRAINT task_changes_shape_valid CHECK (
    (kind = 'details'
      AND from_title IS NOT NULL AND to_title IS NOT NULL
      AND from_priority IS NOT NULL AND to_priority IS NOT NULL
      AND from_assigned_to IS NULL AND to_assigned_to IS NULL
      AND from_status IS NULL AND to_status IS NULL)
    OR
    (kind = 'assignment'
      AND from_title IS NULL AND to_title IS NULL
      AND from_description IS NULL AND to_description IS NULL
      AND from_due_on IS NULL AND to_due_on IS NULL
      AND from_priority IS NULL AND to_priority IS NULL
      AND from_assigned_to IS NOT NULL AND to_assigned_to IS NOT NULL
      AND from_status IS NULL AND to_status IS NULL)
    OR
    (kind = 'status'
      AND from_title IS NULL AND to_title IS NULL
      AND from_description IS NULL AND to_description IS NULL
      AND from_due_on IS NULL AND to_due_on IS NULL
      AND from_priority IS NULL AND to_priority IS NULL
      AND from_assigned_to IS NULL AND to_assigned_to IS NULL
      AND from_status IS NOT NULL AND to_status IS NOT NULL)
  ),
  CONSTRAINT task_changes_title_length CHECK (
    (from_title IS NULL OR length(btrim(from_title)) BETWEEN 1 AND 200)
    AND (to_title IS NULL OR length(btrim(to_title)) BETWEEN 1 AND 200)
  ),
  CONSTRAINT task_changes_title_safe CHECK (app.is_safe_text(from_title) AND app.is_safe_text(to_title)),
  CONSTRAINT task_changes_description_length CHECK (
    (from_description IS NULL OR length(btrim(from_description)) BETWEEN 1 AND 2000)
    AND (to_description IS NULL OR length(btrim(to_description)) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT task_changes_description_safe CHECK (app.is_safe_text(from_description) AND app.is_safe_text(to_description)),
  CONSTRAINT task_changes_due_on_supported CHECK (
    (from_due_on IS NULL OR from_due_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31')
    AND (to_due_on IS NULL OR to_due_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31')
  ),
  CONSTRAINT task_changes_priority_valid CHECK (
    (from_priority IS NULL OR from_priority IN ('low', 'normal', 'high', 'urgent'))
    AND (to_priority IS NULL OR to_priority IN ('low', 'normal', 'high', 'urgent'))
  ),
  CONSTRAINT task_changes_status_valid CHECK (
    (from_status IS NULL OR from_status IN ('open', 'completed', 'cancelled'))
    AND (to_status IS NULL OR to_status IN ('open', 'completed', 'cancelled'))
  )
);

CREATE INDEX task_changes_task_id_idx ON app.task_changes (task_id, id);

REVOKE INSERT ON app.task_changes FROM pms_app;
GRANT INSERT (
  task_id, kind, to_title, to_description, to_due_on, to_priority,
  to_assigned_to, to_status, changed_by
) ON app.task_changes TO pms_app;

-- A nested update made by the task_changes trigger is allowed to change only
-- the current fields. Direct updates and every deletion still fail, including
-- for the table owner.
CREATE OR REPLACE FUNCTION app.refuse_task_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'a task''s identity, matter and creation record are fixed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'tasks cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_task_change() FROM PUBLIC;

CREATE FUNCTION app.apply_task_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  matter       uuid;
  current_task app.tasks%ROWTYPE;
BEGIN
  SELECT matter_id INTO matter FROM app.tasks WHERE id = NEW.task_id;
  IF matter IS NULL THEN
    RAISE EXCEPTION 'no task with this id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Closure takes an UPDATE lock on this row. All task work takes a SHARE
  -- lock, so closure and work are ordered rather than passing one another.
  PERFORM 1
  FROM app.matters m
  WHERE m.id = matter AND m.status = 'open'
  FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tasks are changed only on open matters'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO current_task FROM app.tasks WHERE id = NEW.task_id FOR UPDATE;

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
    RAISE EXCEPTION 'tasks are changed only by active matter team members'
      USING ERRCODE = 'check_violation';
  END IF;

  CASE NEW.kind
    WHEN 'details' THEN
      IF NEW.to_title IS NULL OR NEW.to_priority IS NULL
        OR NEW.to_assigned_to IS NOT NULL OR NEW.to_status IS NOT NULL
      THEN
        RAISE EXCEPTION 'a details change needs complete task details only'
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.from_title := current_task.title;
      NEW.from_description := current_task.description;
      NEW.from_due_on := current_task.due_on;
      NEW.from_priority := current_task.priority;
      IF (NEW.to_title, NEW.to_description, NEW.to_due_on, NEW.to_priority)
        IS NOT DISTINCT FROM
        (current_task.title, current_task.description, current_task.due_on, current_task.priority)
      THEN
        RETURN NULL;
      END IF;

      UPDATE app.tasks
      SET title = NEW.to_title,
          description = NEW.to_description,
          due_on = NEW.to_due_on,
          priority = NEW.to_priority
      WHERE id = NEW.task_id;

    WHEN 'assignment' THEN
      IF NEW.to_assigned_to IS NULL
        OR NEW.to_title IS NOT NULL OR NEW.to_description IS NOT NULL
        OR NEW.to_due_on IS NOT NULL OR NEW.to_priority IS NOT NULL
        OR NEW.to_status IS NOT NULL
      THEN
        RAISE EXCEPTION 'an assignment change needs an assignee only'
          USING ERRCODE = 'check_violation';
      END IF;

      PERFORM 1
      FROM app.matter_team t
      JOIN app.accounts a ON a.id = t.account_id
      WHERE t.matter_id = matter
        AND t.account_id = NEW.to_assigned_to
        AND t.removed_at IS NULL
        AND a.kind = 'staff'
        AND a.status = 'active'
      FOR SHARE OF t, a;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'a task assignee must be an active matter team member'
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.from_assigned_to := current_task.assigned_to;
      IF NEW.to_assigned_to = current_task.assigned_to THEN
        RETURN NULL;
      END IF;
      UPDATE app.tasks SET assigned_to = NEW.to_assigned_to WHERE id = NEW.task_id;

    WHEN 'status' THEN
      IF NEW.to_status IS NULL
        OR NEW.to_title IS NOT NULL OR NEW.to_description IS NOT NULL
        OR NEW.to_due_on IS NOT NULL OR NEW.to_priority IS NOT NULL
        OR NEW.to_assigned_to IS NOT NULL
      THEN
        RAISE EXCEPTION 'a status change needs a status only'
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.changed_by <> current_task.assigned_to AND NOT EXISTS (
        SELECT 1 FROM app.matter_team t
        WHERE t.matter_id = matter
          AND t.account_id = NEW.changed_by
          AND t.role = 'supervising_partner'
          AND t.removed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'task status is changed only by its assignee or supervising partner'
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.from_status := current_task.status;
      IF NEW.to_status = current_task.status THEN
        RETURN NULL;
      END IF;
      IF current_task.status <> 'open' AND NEW.to_status <> 'open' THEN
        RAISE EXCEPTION 'a completed or cancelled task must be reopened before another final status'
          USING ERRCODE = 'check_violation';
      END IF;
      IF current_task.status = 'open' AND NEW.to_status = 'open' THEN
        RETURN NULL;
      END IF;

      UPDATE app.tasks SET status = NEW.to_status WHERE id = NEW.task_id;

    ELSE
      RAISE EXCEPTION 'unknown task change kind'
        USING ERRCODE = 'check_violation';
  END CASE;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_task_change() FROM PUBLIC;

CREATE TRIGGER task_changes_apply
  BEFORE INSERT ON app.task_changes
  FOR EACH ROW EXECUTE FUNCTION app.apply_task_change();

CREATE FUNCTION app.refuse_task_change_record_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task changes cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_task_change_record_edit() FROM PUBLIC;

CREATE TRIGGER task_changes_fixed
  BEFORE UPDATE OR DELETE ON app.task_changes
  FOR EACH ROW EXECUTE FUNCTION app.refuse_task_change_record_edit();

CREATE TRIGGER task_changes_no_truncate
  BEFORE TRUNCATE ON app.task_changes
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_task_change_record_edit();

-- Preserve all of the existing closure checks, and add the task gate while
-- the matter row is locked against task creation or changes.
CREATE OR REPLACE FUNCTION app.apply_matter_closure() RETURNS trigger
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

  IF EXISTS (SELECT 1 FROM app.tasks WHERE matter_id = NEW.matter_id AND status = 'open') THEN
    RAISE EXCEPTION 'a matter with open tasks cannot be closed'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.matters SET status = 'closed' WHERE id = NEW.matter_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_matter_closure() FROM PUBLIC;
