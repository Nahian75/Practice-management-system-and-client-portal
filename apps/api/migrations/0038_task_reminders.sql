-- Due-date reminders and generic task email (docs/notifications.md, step 13c).
ALTER TABLE app.email_outbox DROP CONSTRAINT email_outbox_kind_valid;
ALTER TABLE app.email_outbox ADD CONSTRAINT email_outbox_kind_valid CHECK (
  kind IN (
    'account_invitation', 'password_reset', 'security_notice',
    'task_assignment', 'task_reminder'
  )
);

-- Catch-up starts when this feature is installed. Earlier reminder points
-- were never promised and must not produce a first-deployment email burst.
CREATE TABLE app.notification_reminder_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_on date NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'Europe/London')::date)
);

INSERT INTO app.notification_reminder_settings DEFAULT VALUES;
GRANT SELECT ON app.notification_reminder_settings TO pms_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.notification_reminder_settings FROM pms_app;

CREATE FUNCTION app.refuse_notification_reminder_settings_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification reminder settings cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_notification_reminder_settings_edit() FROM PUBLIC;

CREATE TRIGGER notification_reminder_settings_fixed
  BEFORE UPDATE OR DELETE ON app.notification_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION app.refuse_notification_reminder_settings_edit();

CREATE TRIGGER notification_reminder_settings_no_truncate
  BEFORE TRUNCATE ON app.notification_reminder_settings
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_notification_reminder_settings_edit();

CREATE FUNCTION app.create_task_reminders_through(through_date date)
RETURNS TABLE (
  notification_id uuid,
  recipient_id uuid,
  kind text,
  task_id uuid,
  due_on date,
  reminder_point text,
  email text,
  deduplication_key text
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  reminder_start date;
BEGIN
  IF through_date IS NULL THEN
    RAISE EXCEPTION 'a London calendar date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.task_reminders', 0));
  SELECT settings.starts_on INTO reminder_start
  FROM app.notification_reminder_settings settings;

  IF through_date < reminder_start THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      t.id AS candidate_task_id,
      t.assigned_to AS candidate_recipient_id,
      t.due_on AS candidate_due_on,
      point.notice_kind,
      point.reminder_point,
      a.email AS candidate_email,
      'task:' || t.id::text || ':due:' || t.due_on::text || ':' ||
        point.reminder_point || ':' || t.assigned_to::text AS candidate_key
    FROM app.matters m
    JOIN app.tasks t ON t.matter_id = m.id
    JOIN app.matter_team mt
      ON mt.matter_id = m.id
      AND mt.account_id = t.assigned_to
      AND mt.removed_at IS NULL
    JOIN app.accounts a
      ON a.id = t.assigned_to
      AND a.kind = 'staff'
      AND a.status = 'active'
    CROSS JOIN LATERAL (VALUES
      (t.due_on - 7, 'task_due_soon', '7_days'),
      (t.due_on - 1, 'task_due_soon', '1_day'),
      (t.due_on,     'task_due_today', 'today'),
      (t.due_on + 1, 'task_overdue', 'overdue')
    ) AS point(scheduled_on, notice_kind, reminder_point)
    WHERE m.status = 'open'
      AND t.status = 'open'
      AND t.due_on IS NOT NULL
      AND point.scheduled_on BETWEEN reminder_start AND through_date
    FOR SHARE OF m, t, mt, a
  ), inserted AS (
    INSERT INTO app.notifications (recipient_id, kind, task_id, deduplication_key)
    SELECT candidate_recipient_id, notice_kind, candidate_task_id, candidate_key
    FROM candidates
    ON CONFLICT (deduplication_key) DO NOTHING
    RETURNING id, recipient_id, kind, task_id, deduplication_key
  )
  SELECT
    inserted.id,
    inserted.recipient_id,
    inserted.kind,
    inserted.task_id,
    candidates.candidate_due_on,
    candidates.reminder_point,
    candidates.candidate_email,
    inserted.deduplication_key
  FROM inserted
  JOIN candidates ON candidates.candidate_key = inserted.deduplication_key
  ORDER BY inserted.id;
END;
$$;

REVOKE ALL ON FUNCTION app.create_task_reminders_through(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_task_reminders_through(date) TO pms_app;
