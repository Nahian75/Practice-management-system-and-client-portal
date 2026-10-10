-- Compliance / AML step 15d-1: immutable versions of the official UK Sanctions
-- List and a record of every refresh, so a stale list is visible and can fail closed.

-- Birth dates as the list gives them: a year, a year and month, or a full date.
CREATE FUNCTION app.is_sanctions_birth_list(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT cardinality(value) <= 50 AND NOT EXISTS (SELECT 1 FROM unnest(value) b WHERE b IS NULL OR b !~ '^\d{4}(-\d{2}(-\d{2})?)?$')
$$;
REVOKE ALL ON FUNCTION app.is_sanctions_birth_list(text[]) FROM PUBLIC;

CREATE TABLE app.aml_sanctions_lists (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  version            integer     NOT NULL UNIQUE,
  report_date        date        NOT NULL,
  sha256             bytea       NOT NULL UNIQUE,
  byte_size          integer     NOT NULL,
  source             text        NOT NULL,
  designation_count  integer     NOT NULL,
  name_count         integer     NOT NULL,
  imported_by        uuid        REFERENCES app.accounts(id),
  imported_at        timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_sanctions_lists_version_positive CHECK (version > 0),
  CONSTRAINT aml_sanctions_lists_hash_valid CHECK (octet_length(sha256) = 32),
  CONSTRAINT aml_sanctions_lists_size_valid CHECK (byte_size BETWEEN 1 AND 157286400),
  CONSTRAINT aml_sanctions_lists_source_valid CHECK (
    (source = 'download' AND imported_by IS NULL) OR (source = 'upload' AND imported_by IS NOT NULL)
  ),
  CONSTRAINT aml_sanctions_lists_counts_valid CHECK (designation_count BETWEEN 1 AND 100000 AND name_count >= designation_count)
);

CREATE TABLE app.aml_sanctions_designations (
  list_id          uuid    NOT NULL REFERENCES app.aml_sanctions_lists(id),
  unique_id        text    NOT NULL,
  kind             text    NOT NULL,
  regime           text    NOT NULL,
  date_designated  date,
  births           text[]  NOT NULL,
  nationalities    text[]  NOT NULL,
  PRIMARY KEY (list_id, unique_id),

  CONSTRAINT aml_sanctions_designations_id_valid CHECK (unique_id ~ '^[A-Za-z0-9][A-Za-z0-9./-]{1,49}$'),
  CONSTRAINT aml_sanctions_designations_kind_valid CHECK (kind IN ('individual', 'entity', 'ship')),
  CONSTRAINT aml_sanctions_designations_regime_safe CHECK (app.is_safe_text(regime) AND length(regime) BETWEEN 1 AND 500),
  CONSTRAINT aml_sanctions_designations_births_valid CHECK (app.is_sanctions_birth_list(births)),
  CONSTRAINT aml_sanctions_designations_nationalities_valid CHECK (cardinality(nationalities) <= 50)
);

CREATE TABLE app.aml_sanctions_names (
  list_id     uuid     NOT NULL,
  unique_id   text     NOT NULL,
  name        text     NOT NULL,
  normalized  text     NOT NULL,
  tokens      text[]   NOT NULL,
  is_primary  boolean  NOT NULL,
  FOREIGN KEY (list_id, unique_id) REFERENCES app.aml_sanctions_designations(list_id, unique_id),

  CONSTRAINT aml_sanctions_names_name_safe CHECK (app.is_safe_text(name) AND length(name) BETWEEN 1 AND 500),
  CONSTRAINT aml_sanctions_names_normalized_valid CHECK (length(normalized) BETWEEN 1 AND 500),
  CONSTRAINT aml_sanctions_names_tokens_valid CHECK (cardinality(tokens) BETWEEN 1 AND 60)
);
CREATE INDEX aml_sanctions_names_list_idx ON app.aml_sanctions_names (list_id, unique_id);
CREATE INDEX aml_sanctions_names_tokens_idx ON app.aml_sanctions_names USING gin (tokens);

CREATE TABLE app.aml_sanctions_checks (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  outcome     text        NOT NULL,
  list_id     uuid        REFERENCES app.aml_sanctions_lists(id),
  failure     text,
  checked_by  uuid        REFERENCES app.accounts(id),
  checked_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_sanctions_checks_shape_valid CHECK (
    (outcome IN ('imported', 'unchanged') AND list_id IS NOT NULL AND failure IS NULL)
    OR (outcome = 'failed' AND list_id IS NULL AND failure IN ('download', 'too_large', 'format', 'older_report', 'database'))
  )
);
CREATE INDEX aml_sanctions_checks_recent_idx ON app.aml_sanctions_checks (outcome, checked_at DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.aml_sanctions_lists, app.aml_sanctions_designations,
  app.aml_sanctions_names, app.aml_sanctions_checks FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['aml_sanctions_lists', 'aml_sanctions_designations', 'aml_sanctions_names',
    'aml_sanctions_checks'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.protect_aml_risk_insert()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I
      FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate()', table_name, table_name);
  END LOOP;
END $$;

-- Imports a parsed list in one transaction, so a partial list is never visible.
-- An identical file is recorded as `unchanged`; an older report is recorded as a failure
-- and returns a null list id.
-- `actor_id` is null for the scheduled download and a live Compliance holder for an upload.
CREATE FUNCTION app.import_aml_sanctions_list(selected_report date, selected_hash bytea, selected_size integer,
  designations jsonb, names jsonb, actor_id uuid, OUT list_id uuid, OUT changed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE latest app.aml_sanctions_lists%ROWTYPE;
BEGIN
  IF actor_id IS NOT NULL THEN PERFORM app.assert_active_staff_role(actor_id, 'compliance'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_sanctions_list', 0));
  PERFORM set_config('app.aml_risk_write', '1', true);
  SELECT * INTO latest FROM app.aml_sanctions_lists ORDER BY version DESC LIMIT 1;

  SELECT id INTO list_id FROM app.aml_sanctions_lists WHERE sha256 = selected_hash;
  IF FOUND THEN
    changed := false;
    INSERT INTO app.aml_sanctions_checks(outcome, list_id, checked_by) VALUES ('unchanged', list_id, actor_id);
    PERFORM set_config('app.aml_risk_write', '0', true);
    RETURN;
  END IF;
  -- Recorded rather than raised, so the refusal itself is kept. The caller sees a null list id.
  IF latest.id IS NOT NULL AND selected_report < latest.report_date THEN
    INSERT INTO app.aml_sanctions_checks(outcome, failure, checked_by) VALUES ('failed', 'older_report', actor_id);
    PERFORM set_config('app.aml_risk_write', '0', true);
    changed := false;
    RETURN;
  END IF;

  INSERT INTO app.aml_sanctions_lists(version, report_date, sha256, byte_size, source, designation_count, name_count, imported_by)
    VALUES (coalesce(latest.version, 0) + 1, selected_report, selected_hash, selected_size,
      CASE WHEN actor_id IS NULL THEN 'download' ELSE 'upload' END,
      jsonb_array_length(designations), jsonb_array_length(names), actor_id)
    RETURNING id INTO list_id;
  INSERT INTO app.aml_sanctions_designations(list_id, unique_id, kind, regime, date_designated, births, nationalities)
    SELECT list_id, d.unique_id, d.kind, d.regime, d.date_designated, d.births, d.nationalities
    FROM jsonb_to_recordset(designations) AS d(unique_id text, kind text, regime text, date_designated date,
      births text[], nationalities text[]);
  INSERT INTO app.aml_sanctions_names(list_id, unique_id, name, normalized, tokens, is_primary)
    SELECT list_id, n.unique_id, n.name, n.normalized, n.tokens, n.is_primary
    FROM jsonb_to_recordset(names) AS n(unique_id text, name text, normalized text, tokens text[], is_primary boolean);
  INSERT INTO app.aml_sanctions_checks(outcome, list_id, checked_by) VALUES ('imported', list_id, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
  changed := true;
END;
$$;
REVOKE ALL ON FUNCTION app.import_aml_sanctions_list(date, bytea, integer, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_aml_sanctions_list(date, bytea, integer, jsonb, jsonb, uuid) TO pms_app;

CREATE FUNCTION app.record_aml_sanctions_failure(selected_failure text, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM set_config('app.aml_risk_write', '1', true);
  INSERT INTO app.aml_sanctions_checks(outcome, failure, checked_by) VALUES ('failed', selected_failure, actor_id);
  PERFORM set_config('app.aml_risk_write', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_sanctions_failure(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_sanctions_failure(text, uuid) TO pms_app;

-- Whether a list import or unchanged check succeeded within `recent` of now.
CREATE FUNCTION app.aml_sanctions_checked_within(recent interval) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app.aml_sanctions_checks
    WHERE outcome IN ('imported', 'unchanged') AND checked_at > clock_timestamp() - recent)
$$;
REVOKE ALL ON FUNCTION app.aml_sanctions_checked_within(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_sanctions_checked_within(interval) TO pms_app;

-- The active list is the latest version. It is fresh while a successful check
-- happened in the last 48 hours; a stale list makes screening-dependent work fail closed.
CREATE FUNCTION app.aml_sanctions_status(OUT list_id uuid, OUT version integer, OUT report_date date,
  OUT last_success_at timestamptz, OUT last_failure_at timestamptz, OUT fresh boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.id, l.version, l.report_date, s.at, f.at,
    l.id IS NOT NULL AND app.aml_sanctions_checked_within(interval '48 hours')
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT * FROM app.aml_sanctions_lists ORDER BY version DESC LIMIT 1) l ON true
  LEFT JOIN LATERAL (SELECT max(checked_at) AS at FROM app.aml_sanctions_checks WHERE outcome IN ('imported', 'unchanged')) s ON true
  LEFT JOIN LATERAL (SELECT max(checked_at) AS at FROM app.aml_sanctions_checks WHERE outcome = 'failed') f ON true
$$;
REVOKE ALL ON FUNCTION app.aml_sanctions_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_sanctions_status() TO pms_app;
