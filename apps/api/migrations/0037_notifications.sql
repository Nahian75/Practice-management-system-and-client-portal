-- Durable staff task notifications (docs/notifications.md, step 13b).
-- Task triggers create event notifications, so their recipient and source
-- cannot drift from the task change that caused them.
CREATE TABLE app.notifications (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  recipient_id      uuid        NOT NULL REFERENCES app.accounts (id),
  kind              text        NOT NULL,
  task_id           uuid        NOT NULL REFERENCES app.tasks (id),
  deduplication_key text        NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at           timestamptz,

  CONSTRAINT notifications_kind_valid CHECK (kind IN (
    'task_assigned', 'task_unassigned', 'task_completed', 'task_cancelled',
    'task_reopened', 'task_due_soon', 'task_due_today', 'task_overdue'
  ))
);

CREATE INDEX notifications_recipient_page_idx
  ON app.notifications (recipient_id, id DESC);
CREATE INDEX notifications_recipient_unread_idx
  ON app.notifications (recipient_id, id DESC) WHERE read_at IS NULL;

-- Only trusted database triggers create task-event notifications. A later
-- reminder migration can add its own narrow creation function.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.notifications FROM pms_app;

CREATE FUNCTION app.prepare_notification() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  current_assignee uuid;
BEGIN
  NEW.id := uuidv7();
  NEW.created_at := clock_timestamp();
  NEW.read_at := NULL;

  IF NOT EXISTS (
    SELECT 1 FROM app.accounts
    WHERE id = NEW.recipient_id AND kind = 'staff'
  ) THEN
    RAISE EXCEPTION 'a notification needs a staff recipient'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT assigned_to INTO current_assignee FROM app.tasks WHERE id = NEW.task_id;
  IF current_assignee IS NULL THEN
    RAISE EXCEPTION 'a notification needs a task'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.kind = 'task_unassigned' AND NEW.recipient_id = current_assignee THEN
    RAISE EXCEPTION 'an unassignment notification cannot name the current assignee'
      USING ERRCODE = 'check_violation';
  ELSIF NEW.kind <> 'task_unassigned' AND NEW.recipient_id <> current_assignee THEN
    RAISE EXCEPTION 'a task notification must name the current assignee'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.prepare_notification() FROM PUBLIC;

CREATE TRIGGER notifications_prepare
  BEFORE INSERT ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.prepare_notification();

-- A nested update from a notification_reads insert may set read_at once.
-- Every other update, deletion and truncation is refused even for the owner.
CREATE FUNCTION app.refuse_notification_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1
    AND OLD.read_at IS NULL AND NEW.read_at IS NOT NULL
    AND (NEW.id, NEW.recipient_id, NEW.kind, NEW.task_id, NEW.deduplication_key, NEW.created_at)
      IS NOT DISTINCT FROM
        (OLD.id, OLD.recipient_id, OLD.kind, OLD.task_id, OLD.deduplication_key, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'notifications cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_notification_edit() FROM PUBLIC;

CREATE TRIGGER notifications_fixed
  BEFORE UPDATE OR DELETE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.refuse_notification_edit();

CREATE TRIGGER notifications_no_truncate
  BEFORE TRUNCATE ON app.notifications
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_notification_edit();

-- Reading is itself an immutable record and the only route to read_at.
CREATE TABLE app.notification_reads (
  notification_id uuid        PRIMARY KEY REFERENCES app.notifications (id),
  recipient_id    uuid        NOT NULL REFERENCES app.accounts (id),
  read_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.notification_reads FROM pms_app;
GRANT INSERT (notification_id, recipient_id) ON app.notification_reads TO pms_app;

CREATE FUNCTION app.apply_notification_read() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  stored_recipient uuid;
  stored_read_at   timestamptz;
  matter           uuid;
BEGIN
  SELECT n.recipient_id, n.read_at, t.matter_id
    INTO stored_recipient, stored_read_at, matter
    FROM app.notifications n
    JOIN app.tasks t ON t.id = n.task_id
    WHERE n.id = NEW.notification_id
    FOR UPDATE OF n;

  IF stored_recipient IS NULL THEN
    RAISE EXCEPTION 'no notification with this id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF stored_recipient <> NEW.recipient_id THEN
    RAISE EXCEPTION 'a notification is read only by its named recipient'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.matter_team mt
  JOIN app.accounts a ON a.id = mt.account_id
  WHERE mt.matter_id = matter
    AND mt.account_id = NEW.recipient_id
    AND mt.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF mt, a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a notification is read only with current matter access'
      USING ERRCODE = 'check_violation';
  END IF;

  IF stored_read_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  NEW.read_at := clock_timestamp();
  UPDATE app.notifications SET read_at = NEW.read_at WHERE id = NEW.notification_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_notification_read() FROM PUBLIC;

CREATE TRIGGER notification_reads_apply
  BEFORE INSERT ON app.notification_reads
  FOR EACH ROW EXECUTE FUNCTION app.apply_notification_read();

CREATE FUNCTION app.refuse_notification_read_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification read records cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_notification_read_edit() FROM PUBLIC;

CREATE TRIGGER notification_reads_fixed
  BEFORE UPDATE OR DELETE ON app.notification_reads
  FOR EACH ROW EXECUTE FUNCTION app.refuse_notification_read_edit();

CREATE TRIGGER notification_reads_no_truncate
  BEFORE TRUNCATE ON app.notification_reads
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_notification_read_edit();

CREATE FUNCTION app.notify_new_task() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO app.notifications (recipient_id, kind, task_id, deduplication_key)
  VALUES (
    NEW.assigned_to,
    'task_assigned',
    NEW.id,
    'task:' || NEW.id::text || ':created:assigned:' || NEW.assigned_to::text
  ) ON CONFLICT (deduplication_key) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.notify_new_task() FROM PUBLIC;

CREATE TRIGGER tasks_notify_insert
  AFTER INSERT ON app.tasks
  FOR EACH ROW EXECUTE FUNCTION app.notify_new_task();

CREATE FUNCTION app.notify_task_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  recipient uuid;
  notice    text;
BEGIN
  IF NEW.kind = 'assignment' THEN
    INSERT INTO app.notifications (recipient_id, kind, task_id, deduplication_key)
    VALUES (
      NEW.from_assigned_to,
      'task_unassigned',
      NEW.task_id,
      'task:' || NEW.task_id::text || ':change:' || NEW.id::text || ':unassigned:' || NEW.from_assigned_to::text
    ) ON CONFLICT (deduplication_key) DO NOTHING;

    INSERT INTO app.notifications (recipient_id, kind, task_id, deduplication_key)
    VALUES (
      NEW.to_assigned_to,
      'task_assigned',
      NEW.task_id,
      'task:' || NEW.task_id::text || ':change:' || NEW.id::text || ':assigned:' || NEW.to_assigned_to::text
    ) ON CONFLICT (deduplication_key) DO NOTHING;
  ELSIF NEW.kind = 'status' THEN
    SELECT assigned_to INTO recipient FROM app.tasks WHERE id = NEW.task_id;
    IF recipient <> NEW.changed_by THEN
      notice := CASE NEW.to_status
        WHEN 'completed' THEN 'task_completed'
        WHEN 'cancelled' THEN 'task_cancelled'
        WHEN 'open' THEN 'task_reopened'
      END;
      INSERT INTO app.notifications (recipient_id, kind, task_id, deduplication_key)
      VALUES (
        recipient,
        notice,
        NEW.task_id,
        'task:' || NEW.task_id::text || ':change:' || NEW.id::text || ':' ||
          CASE NEW.to_status WHEN 'open' THEN 'reopened' ELSE NEW.to_status END || ':' || recipient::text
      ) ON CONFLICT (deduplication_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.notify_task_change() FROM PUBLIC;

CREATE TRIGGER task_changes_notify
  AFTER INSERT ON app.task_changes
  FOR EACH ROW EXECUTE FUNCTION app.notify_task_change();
