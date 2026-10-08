-- A scheduler may catch up only to the database's current London date. This
-- keeps a mistaken or hostile caller from creating reminders before they are due.
CREATE OR REPLACE FUNCTION app.create_task_reminders_through(through_date date)
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

  IF through_date > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'a future London calendar date cannot be processed'
      USING ERRCODE = 'check_violation';
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
    INSERT INTO app.notifications AS new_notification (
      recipient_id, kind, task_id, deduplication_key
    )
    SELECT candidate_recipient_id, notice_kind, candidate_task_id, candidate_key
    FROM candidates
    ON CONFLICT ON CONSTRAINT notifications_deduplication_key_key DO NOTHING
    RETURNING
      new_notification.id,
      new_notification.recipient_id,
      new_notification.kind,
      new_notification.task_id,
      new_notification.deduplication_key
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
