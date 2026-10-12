-- People / HR step 16a: a separate HR authority, append-only employment
-- history, encrypted personal records and a private-file boundary.

ALTER TABLE app.account_roles DROP CONSTRAINT account_roles_role_valid;
ALTER TABLE app.account_roles ADD CONSTRAINT account_roles_role_valid
  CHECK (role IN ('administrator', 'partner', 'fee_earner', 'accounts', 'compliance', 'hr'));

CREATE TABLE app.hr_people (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id  uuid        NOT NULL UNIQUE REFERENCES app.accounts (id),
  created_by  uuid        NOT NULL REFERENCES app.accounts (id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.hr_contact_versions (
  id          uuid        PRIMARY KEY,
  person_id   uuid        NOT NULL REFERENCES app.hr_people (id),
  context     text        NOT NULL,
  key_version smallint    NOT NULL,
  nonce       bytea       NOT NULL,
  ciphertext  bytea       NOT NULL,
  auth_tag    bytea       NOT NULL,
  recorded_by uuid        NOT NULL REFERENCES app.accounts (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_contact_crypto CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000
  ),
  CONSTRAINT hr_contact_context CHECK (context = 'hr-contact:' || id::text)
);
CREATE INDEX hr_contact_versions_person ON app.hr_contact_versions (person_id, recorded_at DESC, id DESC);

CREATE TABLE app.hr_private_versions (
  id          uuid        PRIMARY KEY,
  person_id   uuid        NOT NULL REFERENCES app.hr_people (id),
  context     text        NOT NULL,
  key_version smallint    NOT NULL,
  nonce       bytea       NOT NULL,
  ciphertext  bytea       NOT NULL,
  auth_tag    bytea       NOT NULL,
  recorded_by uuid        NOT NULL REFERENCES app.accounts (id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_private_crypto CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000
  ),
  CONSTRAINT hr_private_context CHECK (context = 'hr-private:' || id::text)
);
CREATE INDEX hr_private_versions_person ON app.hr_private_versions (person_id, recorded_at DESC, id DESC);

CREATE TABLE app.hr_engagements (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  person_id       uuid NOT NULL REFERENCES app.hr_people (id),
  engagement_kind text NOT NULL,
  started_on      date NOT NULL,
  ended_on        date,
  created_by      uuid NOT NULL REFERENCES app.accounts (id),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_engagement_kind CHECK (
    engagement_kind IN ('employee', 'worker', 'llp_partner', 'equity_partner', 'consultant', 'apprentice', 'trainee')
  ),
  CONSTRAINT hr_engagement_dates CHECK (
    started_on >= DATE '1900-01-01' AND (ended_on IS NULL OR ended_on >= started_on)
  )
);
CREATE UNIQUE INDEX hr_engagements_one_open ON app.hr_engagements (person_id) WHERE ended_on IS NULL;
CREATE INDEX hr_engagements_person ON app.hr_engagements (person_id, started_on DESC, id DESC);

CREATE TABLE app.hr_engagement_endings (
  id             uuid PRIMARY KEY,
  engagement_id  uuid NOT NULL UNIQUE REFERENCES app.hr_engagements (id),
  ended_on       date NOT NULL,
  context        text NOT NULL,
  key_version    smallint NOT NULL,
  nonce          bytea NOT NULL,
  ciphertext     bytea NOT NULL,
  auth_tag       bytea NOT NULL,
  recorded_by    uuid NOT NULL REFERENCES app.accounts (id),
  recorded_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_engagement_ending_crypto CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 10000
  ),
  CONSTRAINT hr_engagement_ending_context CHECK (context = 'hr-engagement-ending:' || id::text)
);

CREATE TABLE app.hr_employment_terms (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  engagement_id uuid NOT NULL REFERENCES app.hr_engagements (id),
  effective_on  date NOT NULL,
  job_title     text NOT NULL,
  team          text,
  work_location text,
  recorded_by   uuid NOT NULL REFERENCES app.accounts (id),
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_terms_title_safe CHECK (app.is_safe_text(job_title) AND length(job_title) BETWEEN 1 AND 200),
  CONSTRAINT hr_terms_team_safe CHECK (team IS NULL OR (app.is_safe_text(team) AND length(team) BETWEEN 1 AND 200)),
  CONSTRAINT hr_terms_location_safe CHECK (work_location IS NULL OR (app.is_safe_text(work_location) AND length(work_location) BETWEEN 1 AND 200))
);
CREATE UNIQUE INDEX hr_employment_terms_effective ON app.hr_employment_terms (engagement_id, effective_on);

CREATE TABLE app.hr_manager_events (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  person_id         uuid NOT NULL REFERENCES app.hr_people (id),
  action            text NOT NULL,
  manager_person_id uuid REFERENCES app.hr_people (id),
  effective_on      date NOT NULL,
  recorded_by       uuid NOT NULL REFERENCES app.accounts (id),
  recorded_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_manager_action CHECK (
    (action = 'assigned' AND manager_person_id IS NOT NULL)
    OR (action = 'cleared' AND manager_person_id IS NULL)
  ),
  CONSTRAINT hr_manager_not_self CHECK (manager_person_id IS NULL OR manager_person_id <> person_id)
);
CREATE UNIQUE INDEX hr_manager_events_effective ON app.hr_manager_events (person_id, effective_on);

CREATE TABLE app.hr_work_patterns (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  engagement_id    uuid NOT NULL REFERENCES app.hr_engagements (id),
  effective_on     date NOT NULL,
  time_zone        text NOT NULL,
  monday_minutes   smallint NOT NULL,
  tuesday_minutes  smallint NOT NULL,
  wednesday_minutes smallint NOT NULL,
  thursday_minutes smallint NOT NULL,
  friday_minutes   smallint NOT NULL,
  saturday_minutes smallint NOT NULL,
  sunday_minutes   smallint NOT NULL,
  recorded_by      uuid NOT NULL REFERENCES app.accounts (id),
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_work_pattern_zone CHECK (app.is_safe_text(time_zone) AND length(time_zone) BETWEEN 1 AND 100),
  CONSTRAINT hr_work_pattern_minutes CHECK (
    monday_minutes BETWEEN 0 AND 1440 AND tuesday_minutes BETWEEN 0 AND 1440
    AND wednesday_minutes BETWEEN 0 AND 1440 AND thursday_minutes BETWEEN 0 AND 1440
    AND friday_minutes BETWEEN 0 AND 1440 AND saturday_minutes BETWEEN 0 AND 1440
    AND sunday_minutes BETWEEN 0 AND 1440
    AND monday_minutes + tuesday_minutes + wednesday_minutes + thursday_minutes
      + friday_minutes + saturday_minutes + sunday_minutes > 0
  )
);
CREATE UNIQUE INDEX hr_work_patterns_effective ON app.hr_work_patterns (engagement_id, effective_on);

CREATE TABLE app.hr_correction_requests (
  id          uuid PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES app.hr_people (id),
  category    text NOT NULL,
  context     text NOT NULL,
  key_version smallint NOT NULL,
  nonce       bytea NOT NULL,
  ciphertext  bytea NOT NULL,
  auth_tag    bytea NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app.accounts (id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_correction_category CHECK (category IN ('contact', 'personal', 'employment', 'manager', 'work_pattern', 'other')),
  CONSTRAINT hr_correction_crypto CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000
  ),
  CONSTRAINT hr_correction_context CHECK (context = 'hr-correction:' || id::text)
);
CREATE INDEX hr_correction_requests_person ON app.hr_correction_requests (person_id, submitted_at DESC, id DESC);

CREATE TABLE app.hr_correction_events (
  id            uuid PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES app.hr_correction_requests (id),
  outcome       text NOT NULL CHECK (outcome IN ('resolved', 'rejected')),
  context       text NOT NULL,
  key_version   smallint NOT NULL,
  nonce         bytea NOT NULL,
  ciphertext    bytea NOT NULL,
  auth_tag      bytea NOT NULL,
  recorded_by   uuid NOT NULL REFERENCES app.accounts (id),
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_correction_event_crypto CHECK (
    key_version > 0 AND octet_length(nonce) = 12 AND octet_length(auth_tag) = 16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000
  ),
  CONSTRAINT hr_correction_event_context CHECK (context = 'hr-correction-event:' || id::text)
);
CREATE UNIQUE INDEX hr_correction_events_once ON app.hr_correction_events (request_id);

CREATE TABLE app.hr_files (
  id                  uuid PRIMARY KEY,
  person_id           uuid NOT NULL REFERENCES app.hr_people (id),
  category            text NOT NULL,
  worker_visible      boolean NOT NULL,
  metadata_context    text NOT NULL,
  metadata_key_version smallint NOT NULL,
  metadata_nonce      bytea NOT NULL,
  metadata_ciphertext bytea NOT NULL,
  metadata_auth_tag   bytea NOT NULL,
  media_type          text NOT NULL,
  size_bytes          integer NOT NULL,
  sha256              bytea NOT NULL,
  storage_key         text NOT NULL UNIQUE,
  file_key_version    smallint NOT NULL,
  file_key_nonce      bytea NOT NULL,
  wrapped_file_key    bytea NOT NULL,
  file_key_tag        bytea NOT NULL,
  uploaded_by         uuid NOT NULL REFERENCES app.accounts (id),
  uploaded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_file_category CHECK (category IN ('contract', 'terms', 'identity', 'personal', 'other')),
  CONSTRAINT hr_file_metadata_crypto CHECK (
    metadata_key_version > 0 AND octet_length(metadata_nonce) = 12
    AND octet_length(metadata_auth_tag) = 16 AND octet_length(metadata_ciphertext) BETWEEN 2 AND 10000
  ),
  CONSTRAINT hr_file_metadata_context CHECK (metadata_context = 'hr-file-metadata:' || id::text),
  CONSTRAINT hr_file_content CHECK (
    app.is_safe_text(media_type) AND length(media_type) BETWEEN 1 AND 100
    AND size_bytes BETWEEN 1 AND 52428800 AND octet_length(sha256) = 32
    AND storage_key ~ '^hr/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND file_key_version > 0 AND octet_length(file_key_nonce) = 12
    AND octet_length(file_key_tag) = 16 AND octet_length(wrapped_file_key) = 32
  )
);
CREATE INDEX hr_files_person ON app.hr_files (person_id, uploaded_at DESC, id DESC);

REVOKE ALL ON app.hr_people, app.hr_contact_versions, app.hr_private_versions,
  app.hr_engagements, app.hr_engagement_endings, app.hr_employment_terms,
  app.hr_manager_events, app.hr_work_patterns, app.hr_correction_requests,
  app.hr_correction_events, app.hr_files FROM pms_app;

CREATE FUNCTION app.protect_hr_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.hr_write', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'HR records are written only through protected functions'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_hr_insert() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hr_people','hr_contact_versions','hr_private_versions','hr_engagements',
    'hr_engagement_endings','hr_employment_terms','hr_manager_events','hr_work_patterns',
    'hr_correction_requests','hr_correction_events','hr_files'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_hr_insert()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.refuse_hr_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HR history is immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_hr_history_change() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hr_people','hr_contact_versions','hr_private_versions','hr_engagement_endings',
    'hr_employment_terms','hr_manager_events','hr_work_patterns','hr_correction_requests',
    'hr_correction_events','hr_files'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_hr_history_change()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.protect_hr_engagement_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.hr_end_engagement', true) IS DISTINCT FROM '1'
      OR NEW.id <> OLD.id OR NEW.person_id <> OLD.person_id
      OR NEW.engagement_kind <> OLD.engagement_kind OR NEW.started_on <> OLD.started_on
      OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
      OR OLD.ended_on IS NOT NULL OR NEW.ended_on IS NULL OR NEW.ended_on < OLD.started_on THEN
    RAISE EXCEPTION 'engagements change only through the protected ending function'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_hr_engagement_end() FROM PUBLIC;
CREATE TRIGGER hr_engagements_fixed BEFORE UPDATE OR DELETE ON app.hr_engagements
  FOR EACH ROW EXECUTE FUNCTION app.protect_hr_engagement_end();

CREATE FUNCTION app.refuse_hr_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'HR history cannot be truncated' USING ERRCODE = 'insufficient_privilege'; END;
$$;
REVOKE ALL ON FUNCTION app.refuse_hr_truncate() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hr_people','hr_contact_versions','hr_private_versions','hr_engagements',
    'hr_engagement_endings','hr_employment_terms','hr_manager_events','hr_work_patterns',
    'hr_correction_requests','hr_correction_events','hr_files'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_hr_truncate()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.assert_active_hr(actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'hr');
END;
$$;
REVOKE ALL ON FUNCTION app.assert_active_hr(uuid) FROM PUBLIC;

CREATE FUNCTION app.assert_hr_person_access(actor_id uuid, target_person uuid, allow_manager boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_account uuid; manager_account uuid;
BEGIN
  PERFORM 1 FROM app.accounts WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT account_id INTO target_account FROM app.hr_people WHERE id = target_person;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF target_account = actor_id THEN RETURN 'self'; END IF;
  PERFORM 1 FROM app.account_roles
    WHERE account_id = actor_id AND role = 'hr' AND revoked_at IS NULL FOR SHARE;
  IF FOUND THEN RETURN 'hr'; END IF;
  IF allow_manager THEN
    SELECT manager.account_id INTO manager_account
      FROM app.hr_manager_events event
      JOIN app.hr_people manager ON manager.id = event.manager_person_id
      WHERE event.person_id = target_person
        AND event.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
        AND EXISTS (SELECT 1 FROM app.hr_engagements worker_engagement
          WHERE worker_engagement.person_id = target_person
            AND worker_engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
            AND (worker_engagement.ended_on IS NULL OR worker_engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date))
        AND EXISTS (SELECT 1 FROM app.hr_engagements manager_engagement
          WHERE manager_engagement.person_id = manager.id
            AND manager_engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
            AND (manager_engagement.ended_on IS NULL OR manager_engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date))
      ORDER BY event.effective_on DESC, event.recorded_at DESC, event.id DESC LIMIT 1;
    IF manager_account = actor_id THEN RETURN 'manager'; END IF;
  END IF;
  RAISE EXCEPTION 'HR person access is not available' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.assert_hr_person_access(uuid, uuid, boolean) FROM PUBLIC;

CREATE FUNCTION app.create_hr_person(target_account uuid, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.accounts WHERE id = target_account AND kind = 'staff' FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_people(account_id, created_by) VALUES(target_account, actor_id)
    RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_person(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_person(uuid, uuid) TO pms_app;

CREATE FUNCTION app.record_hr_contact_version(
  target_id uuid, target_person uuid, selected_context text, selected_key_version smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_auth_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, false);
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_contact_versions(id, person_id, context, key_version, nonce, ciphertext, auth_tag, recorded_by)
    VALUES(target_id, target_person, selected_context, selected_key_version, selected_nonce, selected_ciphertext, selected_auth_tag, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_contact_version(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_contact_version(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_private_version(
  target_id uuid, target_person uuid, selected_context text, selected_key_version smallint,
  selected_nonce bytea, selected_ciphertext bytea, selected_auth_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_private_versions(id, person_id, context, key_version, nonce, ciphertext, auth_tag, recorded_by)
    VALUES(target_id, target_person, selected_context, selected_key_version, selected_nonce, selected_ciphertext, selected_auth_tag, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_private_version(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_private_version(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_engagement(
  target_person uuid, selected_kind text, selected_start date, selected_title text,
  selected_team text, selected_location text, selected_zone text,
  mon smallint, tue smallint, wed smallint, thu smallint, fri smallint, sat smallint, sun smallint,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_person:' || target_person::text, 0));
  PERFORM 1 FROM app.hr_people WHERE id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_start > (clock_timestamp() AT TIME ZONE 'Europe/London')::date + 1827 THEN
    RAISE EXCEPTION 'engagement start is too far in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM app.hr_engagements WHERE person_id = target_person
      AND (ended_on IS NULL OR ended_on >= selected_start)) THEN
    RAISE EXCEPTION 'engagements cannot overlap' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_engagements(person_id, engagement_kind, started_on, created_by)
    VALUES(target_person, selected_kind, selected_start, actor_id) RETURNING id INTO created_id;
  INSERT INTO app.hr_employment_terms(engagement_id, effective_on, job_title, team, work_location, recorded_by)
    VALUES(created_id, selected_start, selected_title, selected_team, selected_location, actor_id);
  INSERT INTO app.hr_work_patterns(engagement_id, effective_on, time_zone, monday_minutes,
    tuesday_minutes, wednesday_minutes, thursday_minutes, friday_minutes, saturday_minutes, sunday_minutes, recorded_by)
    VALUES(created_id, selected_start, selected_zone, mon, tue, wed, thu, fri, sat, sun, actor_id);
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_engagement(uuid,text,date,text,text,text,text,smallint,smallint,smallint,smallint,smallint,smallint,smallint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_engagement(uuid,text,date,text,text,text,text,smallint,smallint,smallint,smallint,smallint,smallint,smallint,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_employment_terms(
  target_person uuid, target_engagement uuid, selected_effective date, selected_title text,
  selected_team text, selected_location text, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE engagement app.hr_engagements%ROWTYPE; created_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_engagement:' || target_engagement::text, 0));
  SELECT * INTO engagement FROM app.hr_engagements
    WHERE id = target_engagement AND person_id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_effective < engagement.started_on OR (engagement.ended_on IS NOT NULL AND selected_effective > engagement.ended_on)
      OR selected_effective <= (SELECT max(effective_on) FROM app.hr_employment_terms WHERE engagement_id = target_engagement) THEN
    RAISE EXCEPTION 'employment terms must move forward within the engagement' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_employment_terms(engagement_id, effective_on, job_title, team, work_location, recorded_by)
    VALUES(target_engagement, selected_effective, selected_title, selected_team, selected_location, actor_id)
    RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_employment_terms(uuid,uuid,date,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_employment_terms(uuid,uuid,date,text,text,text,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_work_pattern(
  target_person uuid, target_engagement uuid, selected_effective date, selected_zone text,
  mon smallint, tue smallint, wed smallint, thu smallint, fri smallint, sat smallint, sun smallint,
  actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE engagement app.hr_engagements%ROWTYPE; created_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_engagement:' || target_engagement::text, 0));
  SELECT * INTO engagement FROM app.hr_engagements
    WHERE id = target_engagement AND person_id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_effective < engagement.started_on OR (engagement.ended_on IS NOT NULL AND selected_effective > engagement.ended_on)
      OR selected_effective <= (SELECT max(effective_on) FROM app.hr_work_patterns WHERE engagement_id = target_engagement) THEN
    RAISE EXCEPTION 'work patterns must move forward within the engagement' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_work_patterns(engagement_id, effective_on, time_zone, monday_minutes,
    tuesday_minutes, wednesday_minutes, thursday_minutes, friday_minutes, saturday_minutes, sunday_minutes, recorded_by)
    VALUES(target_engagement, selected_effective, selected_zone, mon, tue, wed, thu, fri, sat, sun, actor_id)
    RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_work_pattern(uuid,uuid,date,text,smallint,smallint,smallint,smallint,smallint,smallint,smallint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_work_pattern(uuid,uuid,date,text,smallint,smallint,smallint,smallint,smallint,smallint,smallint,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_manager_event(
  target_person uuid, selected_manager uuid, selected_effective date, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid; cursor_person uuid; hop_count integer := 0;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_managers', 0));
  PERFORM 1 FROM app.hr_people WHERE id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_effective <= coalesce((SELECT max(effective_on) FROM app.hr_manager_events WHERE person_id = target_person), DATE '0001-01-01') THEN
    RAISE EXCEPTION 'manager events must move forward' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM app.hr_engagements WHERE person_id = target_person AND started_on <= selected_effective
    AND (ended_on IS NULL OR ended_on >= selected_effective) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the worker has no engagement on that date' USING ERRCODE = 'check_violation'; END IF;
  IF selected_manager IS NOT NULL THEN
    PERFORM 1 FROM app.hr_engagements WHERE person_id = selected_manager AND started_on <= selected_effective
      AND (ended_on IS NULL OR ended_on >= selected_effective) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'the manager has no engagement on that date' USING ERRCODE = 'check_violation'; END IF;
    cursor_person := selected_manager;
    WHILE cursor_person IS NOT NULL LOOP
      IF cursor_person = target_person THEN RAISE EXCEPTION 'reporting lines cannot contain a cycle' USING ERRCODE = 'check_violation'; END IF;
      hop_count := hop_count + 1;
      IF hop_count > 100 THEN RAISE EXCEPTION 'reporting line is too deep' USING ERRCODE = 'program_limit_exceeded'; END IF;
      SELECT manager_person_id INTO cursor_person FROM app.hr_manager_events
        WHERE person_id = cursor_person AND effective_on <= selected_effective
        ORDER BY effective_on DESC, recorded_at DESC, id DESC LIMIT 1;
    END LOOP;
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_manager_events(person_id, action, manager_person_id, effective_on, recorded_by)
    VALUES(target_person, CASE WHEN selected_manager IS NULL THEN 'cleared' ELSE 'assigned' END,
      selected_manager, selected_effective, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_manager_event(uuid,uuid,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_manager_event(uuid,uuid,date,uuid) TO pms_app;

CREATE FUNCTION app.end_hr_engagement(
  target_person uuid, target_engagement uuid, target_ending uuid, selected_end date, selected_context text,
  selected_key_version smallint, selected_nonce bytea, selected_ciphertext bytea,
  selected_auth_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE engagement app.hr_engagements%ROWTYPE;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_engagement:' || target_engagement::text, 0));
  SELECT * INTO engagement FROM app.hr_engagements
    WHERE id = target_engagement AND person_id = target_person FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF engagement.ended_on IS NOT NULL OR selected_end < engagement.started_on
      OR selected_end < (SELECT max(effective_on) FROM app.hr_employment_terms WHERE engagement_id = target_engagement)
      OR selected_end < (SELECT max(effective_on) FROM app.hr_work_patterns WHERE engagement_id = target_engagement)
      OR selected_end < (SELECT max(effective_on) FROM app.hr_manager_events WHERE person_id = target_person) THEN
    RAISE EXCEPTION 'the engagement cannot end on that date' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_engagement_endings(id, engagement_id, ended_on, context, key_version,
    nonce, ciphertext, auth_tag, recorded_by)
    VALUES(target_ending, target_engagement, selected_end, selected_context, selected_key_version,
      selected_nonce, selected_ciphertext, selected_auth_tag, actor_id);
  PERFORM set_config('app.hr_end_engagement', '1', true);
  UPDATE app.hr_engagements SET ended_on = selected_end WHERE id = target_engagement;
END;
$$;
REVOKE ALL ON FUNCTION app.end_hr_engagement(uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_hr_engagement(uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_correction_request(
  target_id uuid, target_person uuid, selected_category text, selected_context text,
  selected_key_version smallint, selected_nonce bytea, selected_ciphertext bytea,
  selected_auth_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, false);
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_correction_requests(id, person_id, category, context, key_version,
    nonce, ciphertext, auth_tag, submitted_by)
    VALUES(target_id, target_person, selected_category, selected_context, selected_key_version,
      selected_nonce, selected_ciphertext, selected_auth_tag, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_correction_request(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_correction_request(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.decide_hr_correction_request(
  target_person uuid, target_event uuid, target_request uuid, selected_outcome text, selected_context text,
  selected_key_version smallint, selected_nonce bytea, selected_ciphertext bytea,
  selected_auth_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_correction_requests
    WHERE id = target_request AND person_id = target_person FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF EXISTS (SELECT 1 FROM app.hr_correction_events WHERE request_id = target_request) THEN
    RAISE EXCEPTION 'the correction request already has a decision' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_correction_events(id, request_id, outcome, context, key_version,
    nonce, ciphertext, auth_tag, recorded_by)
    VALUES(target_event, target_request, selected_outcome, selected_context, selected_key_version,
      selected_nonce, selected_ciphertext, selected_auth_tag, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.decide_hr_correction_request(uuid,uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_hr_correction_request(uuid,uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_file(
  target_id uuid, target_person uuid, selected_category text, selected_visible boolean,
  selected_metadata_context text, selected_metadata_key_version smallint, selected_metadata_nonce bytea,
  selected_metadata_ciphertext bytea, selected_metadata_auth_tag bytea, selected_media_type text,
  selected_size integer, selected_sha bytea, selected_storage_key text, selected_file_key_version smallint,
  selected_file_key_nonce bytea, selected_wrapped_key bytea, selected_file_key_tag bytea, actor_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id = target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write', '1', true);
  INSERT INTO app.hr_files(id, person_id, category, worker_visible, metadata_context,
    metadata_key_version, metadata_nonce, metadata_ciphertext, metadata_auth_tag,
    media_type, size_bytes, sha256, storage_key, file_key_version, file_key_nonce,
    wrapped_file_key, file_key_tag, uploaded_by)
    VALUES(target_id, target_person, selected_category, selected_visible, selected_metadata_context,
      selected_metadata_key_version, selected_metadata_nonce, selected_metadata_ciphertext,
      selected_metadata_auth_tag, selected_media_type, selected_size, selected_sha,
      selected_storage_key, selected_file_key_version, selected_file_key_nonce,
      selected_wrapped_key, selected_file_key_tag, actor_id);
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_file(uuid,uuid,text,boolean,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_file(uuid,uuid,text,boolean,text,smallint,bytea,bytea,bytea,text,integer,bytea,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

-- Safe directory data is available to active staff. The API permission guard
-- still requires hr.directory; this database check prevents use after disable.
CREATE FUNCTION app.list_hr_directory(actor_id uuid)
RETURNS TABLE(account_id uuid, person_id uuid, display_name text, work_email text,
  job_title text, team text, work_location text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY
  SELECT account.id, person.id, account.display_name, account.email,
    terms.job_title, terms.team, terms.work_location
  FROM app.accounts account
  LEFT JOIN app.hr_people person ON person.account_id = account.id
  LEFT JOIN app.hr_engagements engagement ON engagement.person_id = person.id
    AND engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    AND (engagement.ended_on IS NULL OR engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date)
  LEFT JOIN LATERAL (
    SELECT item.job_title, item.team, item.work_location FROM app.hr_employment_terms item
    WHERE item.engagement_id = engagement.id
      AND item.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    ORDER BY item.effective_on DESC, item.recorded_at DESC, item.id DESC LIMIT 1
  ) terms ON true
  WHERE account.kind = 'staff' AND account.status = 'active'
  ORDER BY account.display_name, account.email
  LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_directory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_directory(uuid) TO pms_app;

CREATE FUNCTION app.list_hr_people(actor_id uuid)
RETURNS TABLE(person_id uuid, account_id uuid, display_name text, work_email text,
  account_status text, engagement_id uuid, engagement_kind text, started_on date,
  ended_on date, job_title text, team text, work_location text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY
  SELECT person.id, account.id, account.display_name, account.email, account.status,
    engagement.id, engagement.engagement_kind, engagement.started_on, engagement.ended_on,
    terms.job_title, terms.team, terms.work_location
  FROM app.hr_people person
  JOIN app.accounts account ON account.id = person.account_id
  LEFT JOIN LATERAL (
    SELECT item.* FROM app.hr_engagements item WHERE item.person_id = person.id
    ORDER BY (item.ended_on IS NULL) DESC, item.started_on DESC, item.id DESC LIMIT 1
  ) engagement ON true
  LEFT JOIN LATERAL (
    SELECT item.job_title, item.team, item.work_location FROM app.hr_employment_terms item
    WHERE item.engagement_id = engagement.id
      AND item.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    ORDER BY item.effective_on DESC, item.recorded_at DESC, item.id DESC LIMIT 1
  ) terms ON true
  ORDER BY account.display_name, account.email
  LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_people(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_people(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_person_summary(target_person uuid, actor_id uuid)
RETURNS TABLE(person_id uuid, account_id uuid, display_name text, work_email text,
  account_status text, access_kind text, engagement_id uuid, engagement_kind text,
  started_on date, ended_on date, job_title text, team text, work_location text,
  manager_person_id uuid, manager_account_id uuid, manager_name text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed := app.assert_hr_person_access(actor_id, target_person, true);
  RETURN QUERY
  SELECT person.id, account.id, account.display_name, account.email, account.status, allowed,
    engagement.id, engagement.engagement_kind, engagement.started_on, engagement.ended_on,
    terms.job_title, terms.team, terms.work_location,
    manager_event.manager_person_id, manager_account.id, manager_account.display_name
  FROM app.hr_people person
  JOIN app.accounts account ON account.id = person.account_id
  LEFT JOIN LATERAL (
    SELECT item.* FROM app.hr_engagements item WHERE item.person_id = person.id
    ORDER BY (item.ended_on IS NULL) DESC, item.started_on DESC, item.id DESC LIMIT 1
  ) engagement ON true
  LEFT JOIN LATERAL (
    SELECT item.job_title, item.team, item.work_location FROM app.hr_employment_terms item
    WHERE item.engagement_id = engagement.id
      AND item.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    ORDER BY item.effective_on DESC, item.recorded_at DESC, item.id DESC LIMIT 1
  ) terms ON true
  LEFT JOIN LATERAL (
    SELECT item.manager_person_id FROM app.hr_manager_events item
    WHERE item.person_id = person.id
      AND item.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    ORDER BY item.effective_on DESC, item.recorded_at DESC, item.id DESC LIMIT 1
  ) manager_event ON true
  LEFT JOIN app.hr_people manager ON manager.id = manager_event.manager_person_id
  LEFT JOIN app.accounts manager_account ON manager_account.id = manager.account_id
  WHERE person.id = target_person;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_person_summary(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_person_summary(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_own_hr_person(actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE found_id uuid;
BEGIN
  PERFORM 1 FROM app.accounts WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT id INTO found_id FROM app.hr_people WHERE account_id = actor_id;
  RETURN found_id;
END;
$$;
REVOKE ALL ON FUNCTION app.read_own_hr_person(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_own_hr_person(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_contact(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_contact_versions LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, false);
  RETURN QUERY SELECT item.* FROM app.hr_contact_versions item WHERE item.person_id = target_person
    ORDER BY item.recorded_at DESC, item.id DESC LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_contact(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_contact(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_private(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_private_versions LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, false);
  RETURN QUERY SELECT item.* FROM app.hr_private_versions item WHERE item.person_id = target_person
    ORDER BY item.recorded_at DESC, item.id DESC LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_private(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_private(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_engagements(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_engagements LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, true);
  RETURN QUERY SELECT item.* FROM app.hr_engagements item WHERE item.person_id = target_person
    ORDER BY item.started_on DESC, item.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_engagements(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_engagements(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_terms(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_employment_terms LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, true);
  RETURN QUERY SELECT item.* FROM app.hr_employment_terms item
    JOIN app.hr_engagements engagement ON engagement.id = item.engagement_id
    WHERE engagement.person_id = target_person ORDER BY item.effective_on DESC, item.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_terms(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_terms(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_manager_events(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_manager_events LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, true);
  RETURN QUERY SELECT item.* FROM app.hr_manager_events item WHERE item.person_id = target_person
    ORDER BY item.effective_on DESC, item.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_manager_events(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_manager_events(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_work_patterns(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_work_patterns LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, true);
  RETURN QUERY SELECT item.* FROM app.hr_work_patterns item
    JOIN app.hr_engagements engagement ON engagement.id = item.engagement_id
    WHERE engagement.person_id = target_person ORDER BY item.effective_on DESC, item.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_work_patterns(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_work_patterns(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_corrections(target_person uuid, actor_id uuid)
RETURNS TABLE(id uuid, person_id uuid, category text, context text, key_version smallint,
  nonce bytea, ciphertext bytea, auth_tag bytea, submitted_by uuid, submitted_at timestamptz,
  outcome text, event_context text, event_key_version smallint, event_nonce bytea,
  event_ciphertext bytea, event_auth_tag bytea, decided_by uuid, decided_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id, target_person, false);
  RETURN QUERY SELECT request.id, request.person_id, request.category, request.context,
    request.key_version, request.nonce, request.ciphertext, request.auth_tag,
    request.submitted_by, request.submitted_at, event.outcome, event.context,
    event.key_version, event.nonce, event.ciphertext, event.auth_tag,
    event.recorded_by, event.recorded_at
  FROM app.hr_correction_requests request
  LEFT JOIN app.hr_correction_events event ON event.request_id = request.id
  WHERE request.person_id = target_person ORDER BY request.submitted_at DESC, request.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_corrections(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_corrections(uuid, uuid) TO pms_app;

CREATE FUNCTION app.list_hr_corrections(actor_id uuid)
RETURNS TABLE(id uuid, person_id uuid, account_id uuid, display_name text, category text,
  context text, key_version smallint, nonce bytea, ciphertext bytea, auth_tag bytea,
  submitted_by uuid, submitted_at timestamptz, outcome text, event_context text,
  event_key_version smallint, event_nonce bytea, event_ciphertext bytea,
  event_auth_tag bytea, decided_by uuid, decided_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT request.id, request.person_id, person.account_id, account.display_name,
    request.category, request.context, request.key_version, request.nonce,
    request.ciphertext, request.auth_tag, request.submitted_by, request.submitted_at,
    event.outcome, event.context, event.key_version, event.nonce, event.ciphertext,
    event.auth_tag, event.recorded_by, event.recorded_at
  FROM app.hr_correction_requests request
  JOIN app.hr_people person ON person.id = request.person_id
  JOIN app.accounts account ON account.id = person.account_id
  LEFT JOIN app.hr_correction_events event ON event.request_id = request.id
  ORDER BY request.submitted_at DESC, request.id DESC LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_corrections(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_corrections(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_files(target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_files LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed := app.assert_hr_person_access(actor_id, target_person, false);
  RETURN QUERY SELECT item.* FROM app.hr_files item WHERE item.person_id = target_person
    AND (allowed = 'hr' OR item.worker_visible) ORDER BY item.uploaded_at DESC, item.id DESC;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_files(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_files(uuid, uuid) TO pms_app;

CREATE FUNCTION app.read_hr_file(target_file uuid, target_person uuid, actor_id uuid)
RETURNS SETOF app.hr_files LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed := app.assert_hr_person_access(actor_id, target_person, false);
  RETURN QUERY SELECT item.* FROM app.hr_files item WHERE item.id = target_file
    AND item.person_id = target_person AND (allowed = 'hr' OR item.worker_visible);
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_file(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_file(uuid, uuid, uuid) TO pms_app;
