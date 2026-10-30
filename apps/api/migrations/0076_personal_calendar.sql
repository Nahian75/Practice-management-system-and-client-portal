-- Personal appointments are separate from matter tasks. Changes are recorded by cancellation/replacement.
CREATE TABLE app.calendar_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  matter_id uuid REFERENCES app.matters(id),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 1 AND 200),
  description text CHECK (app.is_safe_text(description) AND length(description) <= 2000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (starts_at >= '1900-01-01' AND ends_at < '2101-01-01' AND ends_at > starts_at AND ends_at-starts_at <= interval '30 days')
);
CREATE INDEX calendar_events_owner_date_idx ON app.calendar_events(created_by,starts_at,id);
CREATE INDEX calendar_events_matter_idx ON app.calendar_events(matter_id) WHERE matter_id IS NOT NULL;
CREATE TABLE app.calendar_event_cancellations (
  event_id uuid PRIMARY KEY REFERENCES app.calendar_events(id),
  cancelled_by uuid NOT NULL REFERENCES app.accounts(id),
  cancelled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX calendar_event_cancellations_actor_idx ON app.calendar_event_cancellations(cancelled_by);
REVOKE INSERT ON app.calendar_events FROM pms_app;
GRANT INSERT(created_by,matter_id,title,description,starts_at,ends_at) ON app.calendar_events TO pms_app;
REVOKE INSERT ON app.calendar_event_cancellations FROM pms_app;
GRANT INSERT(event_id,cancelled_by) ON app.calendar_event_cancellations TO pms_app;
CREATE TRIGGER calendar_events_immutable BEFORE UPDATE OR DELETE ON app.calendar_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER calendar_events_no_truncate BEFORE TRUNCATE ON app.calendar_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER calendar_cancellations_immutable BEFORE UPDATE OR DELETE ON app.calendar_event_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER calendar_cancellations_no_truncate BEFORE TRUNCATE ON app.calendar_event_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_event_change();
CREATE FUNCTION app.check_personal_calendar_actor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;
BEGIN
  IF TG_TABLE_NAME='calendar_events' THEN actor := NEW.created_by;
  ELSE actor := NEW.cancelled_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.accounts WHERE id=actor AND kind='staff' AND status='active') THEN
    RAISE EXCEPTION 'Calendar actor must be active staff' USING ERRCODE='check_violation';
  END IF;
  IF TG_TABLE_NAME='calendar_events' THEN
    IF NEW.matter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.matter_team WHERE matter_id=NEW.matter_id AND account_id=actor AND removed_at IS NULL) THEN
      RAISE EXCEPTION 'Calendar matter must be on the actor team' USING ERRCODE='check_violation';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM app.calendar_events WHERE id=NEW.event_id AND created_by=actor) THEN
    RAISE EXCEPTION 'Only the calendar owner can cancel an event' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calendar_events_actor BEFORE INSERT ON app.calendar_events
  FOR EACH ROW EXECUTE FUNCTION app.check_personal_calendar_actor();
CREATE TRIGGER calendar_cancellations_actor BEFORE INSERT ON app.calendar_event_cancellations
  FOR EACH ROW EXECUTE FUNCTION app.check_personal_calendar_actor();
