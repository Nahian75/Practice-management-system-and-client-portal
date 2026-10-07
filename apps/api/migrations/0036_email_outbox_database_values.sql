-- Even the table owner cannot choose identity, queue time or delivery state
-- on insert. Scheduled delivery and encrypted message fields remain inputs.
CREATE FUNCTION app.prepare_email_outbox() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.id := uuidv7();
  NEW.status := 'pending';
  NEW.queued_at := clock_timestamp();
  NEW.expires_at := NEW.queued_at + interval '24 hours';
  NEW.attempt_count := 0;
  NEW.lease_id := NULL;
  NEW.leased_until := NULL;
  NEW.completed_at := NULL;
  NEW.failure_class := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.prepare_email_outbox() FROM PUBLIC;

CREATE TRIGGER email_outbox_prepare
  BEFORE INSERT ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.prepare_email_outbox();
