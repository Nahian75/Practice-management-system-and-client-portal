-- Internal tasks belonging to a matter (docs/tasks.md). Step 12a permits
-- creation and reading only; later changes will be made through insert-only
-- history records.
CREATE TABLE app.tasks (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id   uuid        NOT NULL REFERENCES app.matters (id),
  title       text        NOT NULL,
  description text,
  due_on      date,
  priority    text        NOT NULL DEFAULT 'normal',
  status      text        NOT NULL DEFAULT 'open',
  assigned_to uuid        NOT NULL REFERENCES app.accounts (id),
  created_by  uuid        NOT NULL REFERENCES app.accounts (id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT tasks_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT tasks_title_safe CHECK (app.is_safe_text(title)),
  CONSTRAINT tasks_description_length CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 2000),
  CONSTRAINT tasks_description_safe CHECK (description IS NULL OR app.is_safe_text(description)),
  CONSTRAINT tasks_due_on_supported CHECK (due_on IS NULL OR due_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  CONSTRAINT tasks_priority_valid CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT tasks_status_valid CHECK (status IN ('open', 'completed', 'cancelled'))
);

CREATE INDEX tasks_matter_id_idx ON app.tasks (matter_id, id DESC);

-- The database, not the app, supplies identity, status and creation time.
-- Step 12a has no update path.
REVOKE INSERT ON app.tasks FROM pms_app;
GRANT INSERT (matter_id, title, description, due_on, priority, assigned_to, created_by)
  ON app.tasks TO pms_app;

-- Recheck the matter, creator and assignee in the same statement as the
-- insert. An API check on its own would race a closure or team change.
CREATE FUNCTION app.check_new_task() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM app.matters WHERE id = NEW.matter_id) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'tasks are created only on open matters'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.matter_team t
    JOIN app.accounts a ON a.id = t.account_id
    WHERE t.matter_id = NEW.matter_id
      AND t.account_id = NEW.created_by
      AND t.removed_at IS NULL
      AND a.kind = 'staff'
      AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'tasks are created only by active matter team members'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.matter_team t
    JOIN app.accounts a ON a.id = t.account_id
    WHERE t.matter_id = NEW.matter_id
      AND t.account_id = NEW.assigned_to
      AND t.removed_at IS NULL
      AND a.kind = 'staff'
      AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'a task assignee must be an active matter team member'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.check_new_task() FROM PUBLIC;

CREATE TRIGGER tasks_check_insert
  BEFORE INSERT ON app.tasks
  FOR EACH ROW EXECUTE FUNCTION app.check_new_task();

-- A task is a record. Later migrations may replace the update part with a
-- history-driven path, but deletion remains impossible for every role.
CREATE FUNCTION app.refuse_task_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tasks cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_task_change() FROM PUBLIC;

CREATE TRIGGER tasks_fixed
  BEFORE UPDATE OR DELETE ON app.tasks
  FOR EACH ROW EXECUTE FUNCTION app.refuse_task_change();

CREATE TRIGGER tasks_no_truncate
  BEFORE TRUNCATE ON app.tasks
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_task_change();
