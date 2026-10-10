-- Compliance / AML step 15a: nominated officers and fixed firm-wide controls.

CREATE FUNCTION app.is_safe_document_text(value text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT value IS NOT NULL AND value ~ '[[:alnum:]]'
      AND translate(value, U&'\2028\2029\202A\202B\202C\202D\202E\2066\2067\2068\2069', '') = value
      AND value !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'
  $$;
REVOKE ALL ON FUNCTION app.is_safe_document_text(text) FROM PUBLIC;

CREATE TABLE app.aml_officer_appointments (
  id             uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id     uuid        NOT NULL REFERENCES app.accounts(id),
  kind           text        NOT NULL,
  appointed_by   uuid        NOT NULL REFERENCES app.accounts(id),
  appointed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_by       uuid        REFERENCES app.accounts(id),
  ended_at       timestamptz,
  end_reason     text,

  CONSTRAINT aml_officer_appointments_kind_valid
    CHECK (kind IN ('nominated_officer', 'deputy')),
  CONSTRAINT aml_officer_appointments_end_complete
    CHECK ((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL)
        OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND app.is_safe_text(end_reason)
            AND length(end_reason) BETWEEN 1 AND 500)),
  CONSTRAINT aml_officer_appointments_times_valid
    CHECK (ended_at IS NULL OR ended_at >= appointed_at)
);

CREATE UNIQUE INDEX aml_officer_appointments_active_unique
  ON app.aml_officer_appointments (account_id, kind) WHERE ended_at IS NULL;
CREATE INDEX aml_officer_appointments_current_idx
  ON app.aml_officer_appointments (kind, account_id) WHERE ended_at IS NULL;

CREATE TABLE app.aml_control_versions (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  kind            text        NOT NULL,
  version         integer     NOT NULL,
  title           text        NOT NULL,
  content         text        NOT NULL,
  content_sha256  bytea       NOT NULL,
  source          text        NOT NULL,
  effective_from  date        NOT NULL,
  review_due_on   date        NOT NULL,
  prepared_by     uuid        NOT NULL REFERENCES app.accounts(id),
  prepared_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_control_versions_kind_valid CHECK (kind IN (
    'ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
    'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy', 'training_material'
  )),
  CONSTRAINT aml_control_versions_version_positive CHECK (version > 0),
  CONSTRAINT aml_control_versions_title_safe CHECK (app.is_safe_text(title) AND length(title) BETWEEN 1 AND 200),
  CONSTRAINT aml_control_versions_content_safe CHECK (app.is_safe_document_text(content) AND length(content) BETWEEN 1 AND 200000),
  CONSTRAINT aml_control_versions_hash_matches CHECK (
    octet_length(content_sha256) = 32
    AND content_sha256 = sha256(convert_to(content, 'UTF8'))
  ),
  CONSTRAINT aml_control_versions_source_safe CHECK (app.is_safe_text(source) AND length(source) BETWEEN 1 AND 2000),
  CONSTRAINT aml_control_versions_dates_valid CHECK (
    effective_from >= DATE '1900-01-01' AND review_due_on >= effective_from
  ),
  CONSTRAINT aml_control_versions_kind_version_unique UNIQUE (kind, version)
);
CREATE INDEX aml_control_versions_recent_idx ON app.aml_control_versions (kind, version DESC);

CREATE TABLE app.aml_control_approvals (
  id                 uuid        PRIMARY KEY DEFAULT uuidv7(),
  control_version_id uuid        NOT NULL UNIQUE REFERENCES app.aml_control_versions(id),
  approved_by        uuid        NOT NULL REFERENCES app.accounts(id),
  approved_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.aml_training_completions (
  id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id            uuid        NOT NULL REFERENCES app.accounts(id),
  training_material_id  uuid        NOT NULL REFERENCES app.aml_control_versions(id),
  provider              text        NOT NULL,
  completed_on          date        NOT NULL,
  evidence_reference    text        NOT NULL,
  recorded_by           uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at           timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_training_completions_provider_safe
    CHECK (app.is_safe_text(provider) AND length(provider) BETWEEN 1 AND 200),
  CONSTRAINT aml_training_completions_evidence_safe
    CHECK (app.is_safe_text(evidence_reference) AND length(evidence_reference) BETWEEN 1 AND 1000),
  CONSTRAINT aml_training_completions_date_valid CHECK (completed_on >= DATE '1900-01-01'),
  CONSTRAINT aml_training_completions_unique UNIQUE (account_id, training_material_id)
);
CREATE INDEX aml_training_completions_account_idx ON app.aml_training_completions (account_id, completed_on DESC, id DESC);

CREATE TABLE app.aml_independent_reviews (
  id                     uuid        PRIMARY KEY DEFAULT uuidv7(),
  period_start           date        NOT NULL,
  period_end             date        NOT NULL,
  completed_on           date        NOT NULL,
  reviewer_name          text        NOT NULL,
  reviewer_organisation  text,
  independence_basis     text        NOT NULL,
  scope                  text        NOT NULL,
  findings               text        NOT NULL,
  recommendations        text        NOT NULL,
  management_response    text        NOT NULL,
  recorded_by            uuid        NOT NULL REFERENCES app.accounts(id),
  recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aml_independent_reviews_dates_valid
    CHECK (period_start >= DATE '1900-01-01' AND period_end >= period_start AND completed_on >= period_end),
  CONSTRAINT aml_independent_reviews_reviewer_safe
    CHECK (app.is_safe_text(reviewer_name) AND length(reviewer_name) BETWEEN 1 AND 200),
  CONSTRAINT aml_independent_reviews_organisation_safe
    CHECK (reviewer_organisation IS NULL OR (app.is_safe_text(reviewer_organisation) AND length(reviewer_organisation) BETWEEN 1 AND 200)),
  CONSTRAINT aml_independent_reviews_basis_safe
    CHECK (app.is_safe_text(independence_basis) AND length(independence_basis) BETWEEN 1 AND 2000),
  CONSTRAINT aml_independent_reviews_scope_safe
    CHECK (app.is_safe_document_text(scope) AND length(scope) BETWEEN 1 AND 10000),
  CONSTRAINT aml_independent_reviews_findings_safe
    CHECK (app.is_safe_document_text(findings) AND length(findings) BETWEEN 1 AND 50000),
  CONSTRAINT aml_independent_reviews_recommendations_safe
    CHECK (app.is_safe_document_text(recommendations) AND length(recommendations) BETWEEN 1 AND 50000),
  CONSTRAINT aml_independent_reviews_response_safe
    CHECK (app.is_safe_document_text(management_response) AND length(management_response) BETWEEN 1 AND 50000)
);
CREATE INDEX aml_independent_reviews_completed_idx ON app.aml_independent_reviews (completed_on DESC, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  app.aml_officer_appointments, app.aml_control_versions, app.aml_control_approvals,
  app.aml_training_completions, app.aml_independent_reviews FROM pms_app;

CREATE FUNCTION app.refuse_aml_foundation_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published compliance records are immutable'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_aml_foundation_edit() FROM PUBLIC;

CREATE TRIGGER aml_control_versions_fixed BEFORE UPDATE OR DELETE ON app.aml_control_versions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER aml_control_approvals_fixed BEFORE UPDATE OR DELETE ON app.aml_control_approvals
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER aml_training_completions_fixed BEFORE UPDATE OR DELETE ON app.aml_training_completions
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER aml_independent_reviews_fixed BEFORE UPDATE OR DELETE ON app.aml_independent_reviews
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();

CREATE FUNCTION app.protect_aml_officer_appointment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR current_setting('app.aml_appointment_end', true) <> '1' THEN
    RAISE EXCEPTION 'officer appointments change only through the protected ending function'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.kind <> OLD.kind
      OR NEW.appointed_by <> OLD.appointed_by OR NEW.appointed_at <> OLD.appointed_at
      OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.ended_by IS NULL OR NEW.end_reason IS NULL THEN
    RAISE EXCEPTION 'the officer appointment history is fixed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_aml_officer_appointment() FROM PUBLIC;
CREATE TRIGGER aml_officer_appointments_fixed BEFORE UPDATE OR DELETE ON app.aml_officer_appointments
  FOR EACH ROW EXECUTE FUNCTION app.protect_aml_officer_appointment();

CREATE FUNCTION app.refuse_aml_foundation_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published compliance records cannot be truncated'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_aml_foundation_truncate() FROM PUBLIC;

CREATE TRIGGER aml_officer_appointments_no_truncate BEFORE TRUNCATE ON app.aml_officer_appointments
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER aml_control_versions_no_truncate BEFORE TRUNCATE ON app.aml_control_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER aml_control_approvals_no_truncate BEFORE TRUNCATE ON app.aml_control_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER aml_training_completions_no_truncate BEFORE TRUNCATE ON app.aml_training_completions
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();
CREATE TRIGGER aml_independent_reviews_no_truncate BEFORE TRUNCATE ON app.aml_independent_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();

CREATE FUNCTION app.assert_active_staff_role(actor_id uuid, required_role text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts a
  JOIN app.account_roles r ON r.account_id = a.id
  WHERE a.id = actor_id AND a.kind = 'staff' AND a.status = 'active'
    AND r.role = required_role AND r.revoked_at IS NULL
  FOR SHARE OF a, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the required active staff role is missing' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_active_staff_role(uuid, text) FROM PUBLIC;

CREATE FUNCTION app.appoint_aml_officer(target_account uuid, appointment_kind text, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'administrator');
  IF appointment_kind NOT IN ('nominated_officer', 'deputy') THEN
    RAISE EXCEPTION 'invalid officer appointment kind' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.protected_roles', 0));
  PERFORM app.assert_active_staff_role(target_account, 'compliance');
  INSERT INTO app.aml_officer_appointments(account_id, kind, appointed_by)
    VALUES (target_account, appointment_kind, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.appoint_aml_officer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.appoint_aml_officer(uuid, text, uuid) TO pms_app;

CREATE FUNCTION app.end_aml_officer_appointment(target_id uuid, reason text, actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.aml_officer_appointments%ROWTYPE;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'administrator');
  PERFORM pg_advisory_xact_lock(hashtextextended('app.protected_roles', 0));
  SELECT * INTO target FROM app.aml_officer_appointments WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF target.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'the officer appointment has already ended' USING ERRCODE = 'check_violation';
  END IF;
  IF target.kind = 'nominated_officer' AND NOT EXISTS (
    SELECT 1 FROM app.aml_officer_appointments o
    JOIN app.accounts a ON a.id = o.account_id AND a.kind = 'staff' AND a.status = 'active'
    JOIN app.account_roles r ON r.account_id = a.id AND r.role = 'compliance' AND r.revoked_at IS NULL
    WHERE o.kind = 'nominated_officer' AND o.ended_at IS NULL AND o.id <> target.id
  ) THEN
    RAISE EXCEPTION 'the firm must keep an active nominated officer' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.aml_appointment_end', '1', true);
  UPDATE app.aml_officer_appointments SET ended_by = actor_id,
    ended_at = clock_timestamp(), end_reason = reason WHERE id = target_id;
  PERFORM set_config('app.aml_appointment_end', '0', true);
END;
$$;
REVOKE ALL ON FUNCTION app.end_aml_officer_appointment(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_aml_officer_appointment(uuid, text, uuid) TO pms_app;

-- This trigger also protects changes made outside the HTTP service. It uses the
-- same advisory lock as staff role changes and appointment endings.
CREATE FUNCTION app.protect_active_nominated_officer() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_account uuid;
DECLARE removing_eligibility boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    target_account := OLD.id;
    removing_eligibility := OLD.status = 'active' AND NEW.status <> 'active';
  ELSE
    target_account := OLD.account_id;
    removing_eligibility := OLD.role = 'compliance' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL;
  END IF;
  IF NOT removing_eligibility OR NOT EXISTS (
    SELECT 1 FROM app.aml_officer_appointments o WHERE o.account_id = target_account
      AND o.kind = 'nominated_officer' AND o.ended_at IS NULL
  ) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.protected_roles', 0));
  IF NOT EXISTS (
    SELECT 1 FROM app.aml_officer_appointments o
    JOIN app.accounts a ON a.id = o.account_id AND a.kind = 'staff' AND a.status = 'active'
    JOIN app.account_roles r ON r.account_id = a.id AND r.role = 'compliance' AND r.revoked_at IS NULL
    WHERE o.kind = 'nominated_officer' AND o.ended_at IS NULL AND o.account_id <> target_account
  ) THEN
    RAISE EXCEPTION 'the firm must keep an active nominated officer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.protect_active_nominated_officer() FROM PUBLIC;
CREATE TRIGGER accounts_protect_nominated_officer BEFORE UPDATE OF status ON app.accounts
  FOR EACH ROW EXECUTE FUNCTION app.protect_active_nominated_officer();
CREATE TRIGGER account_roles_protect_nominated_officer BEFORE UPDATE OF revoked_at ON app.account_roles
  FOR EACH ROW EXECUTE FUNCTION app.protect_active_nominated_officer();

CREATE FUNCTION app.create_aml_control_version(
  selected_kind text, selected_title text, selected_content text, selected_hash bytea,
  selected_source text, selected_effective_from date, selected_review_due_on date, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
DECLARE next_version integer;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_control.' || selected_kind, 0));
  SELECT coalesce(max(version), 0) + 1 INTO next_version FROM app.aml_control_versions WHERE kind = selected_kind;
  INSERT INTO app.aml_control_versions(kind, version, title, content, content_sha256, source,
    effective_from, review_due_on, prepared_by)
  VALUES(selected_kind, next_version, selected_title, selected_content, selected_hash, selected_source,
    selected_effective_from, selected_review_due_on, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_aml_control_version(text, text, text, bytea, text, date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_control_version(text, text, text, bytea, text, date, date, uuid) TO pms_app;

CREATE FUNCTION app.approve_aml_control_version(target_id uuid, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target app.aml_control_versions%ROWTYPE;
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'partner');
  SELECT * INTO target FROM app.aml_control_versions WHERE id = target_id FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF target.prepared_by = actor_id THEN
    RAISE EXCEPTION 'the preparer cannot approve this control' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.aml_control_approvals(control_version_id, approved_by)
    VALUES(target_id, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.approve_aml_control_version(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.approve_aml_control_version(uuid, uuid) TO pms_app;

CREATE FUNCTION app.record_aml_training(
  target_account uuid, material_id uuid, selected_provider text, selected_completed_on date,
  selected_evidence text, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM 1 FROM app.accounts a WHERE a.id = actor_id AND a.kind = 'staff' AND a.status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF target_account <> actor_id THEN PERFORM app.assert_active_staff_role(actor_id, 'compliance'); END IF;
  PERFORM 1 FROM app.accounts a WHERE a.id = target_account AND a.kind = 'staff' AND a.status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'training belongs to active staff' USING ERRCODE = 'check_violation'; END IF;
  IF selected_completed_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'training cannot be completed in the future' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM app.aml_control_versions v JOIN app.aml_control_approvals p ON p.control_version_id = v.id
    WHERE v.id = material_id AND v.kind = 'training_material'
      AND selected_completed_on BETWEEN v.effective_from AND v.review_due_on
    FOR SHARE OF v, p;
  IF NOT FOUND THEN RAISE EXCEPTION 'training requires approved material' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO app.aml_training_completions(account_id, training_material_id, provider,
    completed_on, evidence_reference, recorded_by)
  VALUES(target_account, material_id, selected_provider, selected_completed_on,
    selected_evidence, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_training(uuid, uuid, text, date, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_training(uuid, uuid, text, date, text, uuid) TO pms_app;

CREATE FUNCTION app.record_aml_independent_review(
  selected_period_start date, selected_period_end date, selected_completed_on date,
  selected_reviewer_name text, selected_reviewer_organisation text, selected_independence_basis text,
  selected_scope text, selected_findings text, selected_recommendations text,
  selected_management_response text, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  IF selected_completed_on > (clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'a review cannot be completed in the future' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.aml_independent_reviews(period_start, period_end, completed_on, reviewer_name,
    reviewer_organisation, independence_basis, scope, findings, recommendations,
    management_response, recorded_by)
  VALUES(selected_period_start, selected_period_end, selected_completed_on, selected_reviewer_name,
    selected_reviewer_organisation, selected_independence_basis, selected_scope, selected_findings,
    selected_recommendations, selected_management_response, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_aml_independent_review(date, date, date, text, text, text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_aml_independent_review(date, date, date, text, text, text, text, text, text, text, uuid) TO pms_app;
