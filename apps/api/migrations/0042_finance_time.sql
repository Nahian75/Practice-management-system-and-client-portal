-- Finance step 14a: immutable staff rates and time records (docs/finance.md).
CREATE TABLE app.staff_rates (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id         uuid        NOT NULL REFERENCES app.accounts (id),
  hourly_rate_pence  bigint      NOT NULL,
  effective_from     date        NOT NULL,
  created_by         uuid        NOT NULL REFERENCES app.accounts (id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT staff_rates_amount_valid CHECK (hourly_rate_pence BETWEEN 0 AND 1000000),
  CONSTRAINT staff_rates_date_valid CHECK (effective_from BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  CONSTRAINT staff_rates_effective_unique UNIQUE (account_id, effective_from)
);

CREATE INDEX staff_rates_account_date_idx
  ON app.staff_rates (account_id, effective_from DESC, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.staff_rates FROM pms_app;
GRANT INSERT (account_id, hourly_rate_pence, effective_from, created_by)
  ON app.staff_rates TO pms_app;

CREATE FUNCTION app.prepare_staff_rate() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  NEW.id := uuidv7();
  NEW.created_at := clock_timestamp();

  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles r ON r.account_id = a.id
  WHERE a.id = NEW.created_by
    AND a.kind = 'staff'
    AND a.status = 'active'
    AND r.role = 'accounts'
    AND r.revoked_at IS NULL
  FOR SHARE OF a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a staff rate is created only by active accounts staff'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.accounts a
  JOIN app.account_roles r ON r.account_id = a.id
  WHERE a.id = NEW.account_id
    AND a.kind = 'staff'
    AND a.status = 'active'
    AND r.role IN ('partner', 'fee_earner')
    AND r.revoked_at IS NULL
  FOR SHARE OF a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a staff rate needs an active partner or fee earner'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.prepare_staff_rate() FROM PUBLIC;

CREATE TRIGGER staff_rates_prepare
  BEFORE INSERT ON app.staff_rates
  FOR EACH ROW EXECUTE FUNCTION app.prepare_staff_rate();

CREATE FUNCTION app.refuse_staff_rate_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff rates cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_staff_rate_edit() FROM PUBLIC;

CREATE TRIGGER staff_rates_fixed
  BEFORE UPDATE OR DELETE ON app.staff_rates
  FOR EACH ROW EXECUTE FUNCTION app.refuse_staff_rate_edit();

CREATE TRIGGER staff_rates_no_truncate
  BEFORE TRUNCATE ON app.staff_rates
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_staff_rate_edit();

CREATE TABLE app.time_entries (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id           uuid        NOT NULL REFERENCES app.matters (id),
  worker_id           uuid        NOT NULL REFERENCES app.accounts (id),
  worked_on           date        NOT NULL,
  minutes             integer     NOT NULL,
  description         text        NOT NULL,
  hourly_rate_pence   bigint      NOT NULL,
  voided              boolean     NOT NULL DEFAULT false,
  recorded_by         uuid        NOT NULL REFERENCES app.accounts (id),
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT time_entries_date_valid CHECK (worked_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
  CONSTRAINT time_entries_minutes_valid CHECK (minutes BETWEEN 1 AND 1440),
  CONSTRAINT time_entries_description_length CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  CONSTRAINT time_entries_description_safe CHECK (app.is_safe_text(description)),
  CONSTRAINT time_entries_rate_valid CHECK (hourly_rate_pence BETWEEN 0 AND 1000000),
  CONSTRAINT time_entries_own_record CHECK (worker_id = recorded_by)
);

CREATE INDEX time_entries_matter_page_idx ON app.time_entries (matter_id, id DESC);
CREATE INDEX time_entries_worker_page_idx ON app.time_entries (worker_id, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.time_entries FROM pms_app;
GRANT INSERT (matter_id, worker_id, worked_on, minutes, description, recorded_by)
  ON app.time_entries TO pms_app;

CREATE FUNCTION app.prepare_time_entry() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  selected_rate bigint;
BEGIN
  NEW.id := uuidv7();
  NEW.recorded_at := clock_timestamp();
  NEW.voided := false;

  IF NEW.worker_id <> NEW.recorded_by THEN
    RAISE EXCEPTION 'staff record only their own time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.worked_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'time cannot be recorded for a future London date'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.matters m
  WHERE m.id = NEW.matter_id AND m.status = 'open'
  FOR SHARE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time is recorded only on open matters'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.matter_team mt
  JOIN app.accounts a ON a.id = mt.account_id
  WHERE mt.matter_id = NEW.matter_id
    AND mt.account_id = NEW.worker_id
    AND mt.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF mt, a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time is recorded only by an active matter team member'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.account_roles r
  WHERE r.account_id = NEW.worker_id
    AND r.role IN ('partner', 'fee_earner')
    AND r.revoked_at IS NULL
  FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time is recorded only by staff with a time-recording role'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT hourly_rate_pence INTO selected_rate
  FROM app.staff_rates
  WHERE account_id = NEW.worker_id AND effective_from <= NEW.worked_on
  ORDER BY effective_from DESC, id DESC
  LIMIT 1
  FOR SHARE;
  IF selected_rate IS NULL THEN
    RAISE EXCEPTION 'time needs an effective staff rate'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.hourly_rate_pence := selected_rate;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.prepare_time_entry() FROM PUBLIC;

CREATE TRIGGER time_entries_prepare
  BEFORE INSERT ON app.time_entries
  FOR EACH ROW EXECUTE FUNCTION app.prepare_time_entry();

CREATE FUNCTION app.refuse_time_entry_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
      OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
      OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    THEN
      RAISE EXCEPTION 'a time entry''s identity, matter, worker and creation record are fixed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'time entries cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_time_entry_edit() FROM PUBLIC;

CREATE TRIGGER time_entries_fixed
  BEFORE UPDATE OR DELETE ON app.time_entries
  FOR EACH ROW EXECUTE FUNCTION app.refuse_time_entry_edit();

CREATE TRIGGER time_entries_no_truncate
  BEFORE TRUNCATE ON app.time_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_time_entry_edit();

CREATE TABLE app.time_entry_corrections (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  time_entry_id           uuid        NOT NULL REFERENCES app.time_entries (id),
  from_worked_on          date        NOT NULL,
  to_worked_on            date,
  from_minutes            integer     NOT NULL,
  to_minutes              integer,
  from_description        text        NOT NULL,
  to_description          text,
  from_hourly_rate_pence  bigint      NOT NULL,
  to_hourly_rate_pence    bigint,
  reason                  text        NOT NULL,
  corrected_by            uuid        NOT NULL REFERENCES app.accounts (id),
  corrected_at            timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT time_entry_corrections_shape CHECK (
    (to_worked_on IS NULL AND to_minutes IS NULL AND to_description IS NULL AND to_hourly_rate_pence IS NULL)
    OR
    (to_worked_on IS NOT NULL AND to_minutes IS NOT NULL AND to_description IS NOT NULL AND to_hourly_rate_pence IS NOT NULL)
  ),
  CONSTRAINT time_entry_corrections_dates CHECK (
    from_worked_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'
    AND (to_worked_on IS NULL OR to_worked_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31')
  ),
  CONSTRAINT time_entry_corrections_minutes CHECK (
    from_minutes BETWEEN 1 AND 1440 AND (to_minutes IS NULL OR to_minutes BETWEEN 1 AND 1440)
  ),
  CONSTRAINT time_entry_corrections_descriptions CHECK (
    length(btrim(from_description)) BETWEEN 1 AND 1000
    AND app.is_safe_text(from_description)
    AND (to_description IS NULL OR (
      length(btrim(to_description)) BETWEEN 1 AND 1000 AND app.is_safe_text(to_description)
    ))
  ),
  CONSTRAINT time_entry_corrections_rates CHECK (
    from_hourly_rate_pence BETWEEN 0 AND 1000000
    AND (to_hourly_rate_pence IS NULL OR to_hourly_rate_pence BETWEEN 0 AND 1000000)
  ),
  CONSTRAINT time_entry_corrections_reason CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500 AND app.is_safe_text(reason)
  )
);

CREATE INDEX time_entry_corrections_entry_idx
  ON app.time_entry_corrections (time_entry_id, id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.time_entry_corrections FROM pms_app;
GRANT INSERT (time_entry_id, to_worked_on, to_minutes, to_description, reason, corrected_by)
  ON app.time_entry_corrections TO pms_app;

CREATE FUNCTION app.apply_time_entry_correction() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_entry app.time_entries%ROWTYPE;
  selected_rate bigint;
BEGIN
  SELECT * INTO current_entry
  FROM app.time_entries
  WHERE id = NEW.time_entry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no time entry with this id'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF current_entry.voided THEN
    RAISE EXCEPTION 'voided time cannot be corrected again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.corrected_by <> current_entry.worker_id THEN
    RAISE EXCEPTION 'staff correct only their own time'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM app.matters m WHERE m.id = current_entry.matter_id FOR SHARE OF m;
  PERFORM 1
  FROM app.matter_team mt
  JOIN app.accounts a ON a.id = mt.account_id
  WHERE mt.matter_id = current_entry.matter_id
    AND mt.account_id = NEW.corrected_by
    AND mt.removed_at IS NULL
    AND a.kind = 'staff'
    AND a.status = 'active'
  FOR SHARE OF mt, a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time is corrected only by an active matter team member'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM app.account_roles r
  WHERE r.account_id = NEW.corrected_by
    AND r.role IN ('partner', 'fee_earner')
    AND r.revoked_at IS NULL
  FOR SHARE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time is corrected only by staff with a time-recording role'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.id := uuidv7();
  NEW.corrected_at := clock_timestamp();
  NEW.from_worked_on := current_entry.worked_on;
  NEW.from_minutes := current_entry.minutes;
  NEW.from_description := current_entry.description;
  NEW.from_hourly_rate_pence := current_entry.hourly_rate_pence;

  IF NEW.to_worked_on IS NULL AND NEW.to_minutes IS NULL AND NEW.to_description IS NULL THEN
    NEW.to_hourly_rate_pence := NULL;
    UPDATE app.time_entries SET voided = true WHERE id = NEW.time_entry_id;
    RETURN NEW;
  END IF;
  IF NEW.to_worked_on IS NULL OR NEW.to_minutes IS NULL OR NEW.to_description IS NULL THEN
    RAISE EXCEPTION 'a replacement needs a date, minutes and description'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.to_worked_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'time cannot be corrected to a future London date'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT hourly_rate_pence INTO selected_rate
  FROM app.staff_rates
  WHERE account_id = current_entry.worker_id AND effective_from <= NEW.to_worked_on
  ORDER BY effective_from DESC, id DESC
  LIMIT 1
  FOR SHARE;
  IF selected_rate IS NULL THEN
    RAISE EXCEPTION 'a replacement needs an effective staff rate'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.to_hourly_rate_pence := selected_rate;

  IF (NEW.to_worked_on, NEW.to_minutes, NEW.to_description, NEW.to_hourly_rate_pence)
    IS NOT DISTINCT FROM
    (current_entry.worked_on, current_entry.minutes, current_entry.description, current_entry.hourly_rate_pence)
  THEN
    RETURN NULL;
  END IF;

  UPDATE app.time_entries
  SET worked_on = NEW.to_worked_on,
      minutes = NEW.to_minutes,
      description = NEW.to_description,
      hourly_rate_pence = NEW.to_hourly_rate_pence
  WHERE id = NEW.time_entry_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_time_entry_correction() FROM PUBLIC;

CREATE TRIGGER time_entry_corrections_apply
  BEFORE INSERT ON app.time_entry_corrections
  FOR EACH ROW EXECUTE FUNCTION app.apply_time_entry_correction();

CREATE FUNCTION app.refuse_time_entry_correction_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'time entry corrections cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

REVOKE ALL ON FUNCTION app.refuse_time_entry_correction_edit() FROM PUBLIC;

CREATE TRIGGER time_entry_corrections_fixed
  BEFORE UPDATE OR DELETE ON app.time_entry_corrections
  FOR EACH ROW EXECUTE FUNCTION app.refuse_time_entry_correction_edit();

CREATE TRIGGER time_entry_corrections_no_truncate
  BEFORE TRUNCATE ON app.time_entry_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_time_entry_correction_edit();
