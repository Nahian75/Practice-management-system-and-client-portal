-- One durable timer per worker. Revisions serialize concurrent tabs/devices;
-- receipts make converting a paused timer into billable work idempotent.
CREATE TABLE app.work_timers (
  account_id uuid PRIMARY KEY REFERENCES app.accounts(id),
  timer_id uuid NOT NULL UNIQUE,
  revision uuid NOT NULL,
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms BETWEEN 0 AND 31536000000),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.work_timer_receipts (
  timer_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app.accounts(id),
  time_entry_id uuid NOT NULL UNIQUE REFERENCES app.time_entries(id),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON app.work_timers, app.work_timer_receipts FROM pms_app;
GRANT SELECT, INSERT, UPDATE ON app.work_timers TO pms_app;
GRANT SELECT, INSERT ON app.work_timer_receipts TO pms_app;
CREATE FUNCTION app.check_work_timer_worker() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts a JOIN app.account_roles r ON r.account_id=a.id
    WHERE a.id=NEW.account_id AND a.kind='staff' AND a.status='active'
      AND r.role IN ('partner','fee_earner') AND r.revoked_at IS NULL
    FOR SHARE OF a,r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'timer requires an active time-recording worker' USING ERRCODE='check_violation';
  END IF;
  IF TG_TABLE_NAME='work_timers' THEN NEW.updated_at:=clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.check_work_timer_worker() FROM PUBLIC;
CREATE TRIGGER work_timer_worker BEFORE INSERT OR UPDATE ON app.work_timers
  FOR EACH ROW EXECUTE FUNCTION app.check_work_timer_worker();
CREATE TRIGGER work_timer_receipt_worker BEFORE INSERT ON app.work_timer_receipts
  FOR EACH ROW EXECUTE FUNCTION app.check_work_timer_worker();
CREATE TRIGGER work_timer_receipt_fixed BEFORE UPDATE OR DELETE ON app.work_timer_receipts
  FOR EACH ROW EXECUTE FUNCTION app.refuse_staff_rate_edit();
CREATE TRIGGER work_timer_receipt_no_truncate BEFORE TRUNCATE ON app.work_timer_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_staff_rate_edit();
