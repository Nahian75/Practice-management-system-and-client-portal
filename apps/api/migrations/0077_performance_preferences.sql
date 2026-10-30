CREATE TABLE app.performance_preferences (
  account_id uuid PRIMARY KEY REFERENCES app.accounts(id),
  daily_target_minutes integer CHECK (daily_target_minutes BETWEEN 15 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE INSERT ON app.performance_preferences FROM pms_app;
GRANT INSERT(account_id,daily_target_minutes),UPDATE(daily_target_minutes) ON app.performance_preferences TO pms_app;
CREATE FUNCTION app.check_performance_preference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.accounts WHERE id=NEW.account_id AND kind='staff' AND status='active') THEN
    RAISE EXCEPTION 'Performance preferences require active staff' USING ERRCODE='check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER performance_preference_actor BEFORE INSERT OR UPDATE ON app.performance_preferences
  FOR EACH ROW EXECUTE FUNCTION app.check_performance_preference();
