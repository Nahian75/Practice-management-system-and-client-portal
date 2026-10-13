-- Client onboarding addendum 17a: firm policy library and staff acknowledgements.

ALTER TABLE app.aml_control_versions
  DROP CONSTRAINT aml_control_versions_kind_valid,
  ADD CONSTRAINT aml_control_versions_kind_valid CHECK (kind IN (
    'ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
    'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy',
    'conflicts_policy', 'client_care_policy', 'complaints_policy',
    'confidentiality_policy', 'data_protection_policy', 'retention_policy',
    'information_security_policy', 'finance_policy', 'training_material'
  )),
  ADD COLUMN owner_account_id uuid REFERENCES app.accounts(id),
  ADD COLUMN requires_acknowledgement boolean NOT NULL DEFAULT false,
  ADD COLUMN acknowledgement_due_days smallint,
  ADD CONSTRAINT aml_control_versions_acknowledgement_valid CHECK (
    (requires_acknowledgement AND kind IN ('aml_policy', 'sanctions_policy', 'conflicts_policy',
        'client_care_policy', 'complaints_policy', 'confidentiality_policy',
        'data_protection_policy', 'retention_policy', 'information_security_policy', 'finance_policy')
      AND owner_account_id IS NOT NULL
      AND acknowledgement_due_days BETWEEN 1 AND 365)
    OR (NOT requires_acknowledgement AND acknowledgement_due_days IS NULL)
  );

CREATE TABLE app.policy_acknowledgements (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  control_version_id  uuid        NOT NULL REFERENCES app.aml_control_versions(id),
  account_id          uuid        NOT NULL REFERENCES app.accounts(id),
  acknowledged_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT policy_acknowledgements_unique UNIQUE (control_version_id, account_id)
);
CREATE INDEX policy_acknowledgements_account_idx
  ON app.policy_acknowledgements (account_id, acknowledged_at DESC, id DESC);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.policy_acknowledgements FROM pms_app;

CREATE TRIGGER policy_acknowledgements_fixed BEFORE UPDATE OR DELETE ON app.policy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION app.refuse_aml_foundation_edit();
CREATE TRIGGER policy_acknowledgements_no_truncate BEFORE TRUNCATE ON app.policy_acknowledgements
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_aml_foundation_truncate();

DROP FUNCTION app.create_aml_control_version(text, text, text, bytea, text, date, date, uuid);

CREATE FUNCTION app.create_aml_control_version(
  selected_kind text, selected_title text, selected_content text, selected_hash bytea,
  selected_source text, selected_effective_from date, selected_review_due_on date,
  selected_owner uuid, selected_requires_acknowledgement boolean,
  selected_acknowledgement_due_days smallint, actor_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
DECLARE next_version integer;
BEGIN
  PERFORM app.assert_active_staff_role(actor_id, 'compliance');
  PERFORM 1 FROM app.accounts
    WHERE id = selected_owner AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the policy owner must be active staff' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.aml_control.' || selected_kind, 0));
  SELECT coalesce(max(version), 0) + 1 INTO next_version
    FROM app.aml_control_versions WHERE kind = selected_kind;
  INSERT INTO app.aml_control_versions(kind, version, title, content, content_sha256, source,
    effective_from, review_due_on, owner_account_id, requires_acknowledgement,
    acknowledgement_due_days, prepared_by)
  VALUES(selected_kind, next_version, selected_title, selected_content, selected_hash, selected_source,
    selected_effective_from, selected_review_due_on, selected_owner,
    selected_requires_acknowledgement, selected_acknowledgement_due_days, actor_id)
  RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_aml_control_version(
  text, text, text, bytea, text, date, date, uuid, boolean, smallint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_control_version(
  text, text, text, bytea, text, date, date, uuid, boolean, smallint, uuid) TO pms_app;

-- Existing AML setup callers do not need acknowledgement settings. Keep this
-- narrow overload while the expanded policy endpoint uses the full signature.
CREATE FUNCTION app.create_aml_control_version(
  selected_kind text, selected_title text, selected_content text, selected_hash bytea,
  selected_source text, selected_effective_from date, selected_review_due_on date, actor_id uuid
) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT app.create_aml_control_version(selected_kind,selected_title,selected_content,selected_hash,
    selected_source,selected_effective_from,selected_review_due_on,actor_id,false,NULL::smallint,actor_id)
$$;
REVOKE ALL ON FUNCTION app.create_aml_control_version(text,text,text,bytea,text,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_aml_control_version(text,text,text,bytea,text,date,date,uuid) TO pms_app;

CREATE FUNCTION app.acknowledge_policy(target_control uuid, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM 1 FROM app.accounts
    WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active staff required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM app.aml_control_versions control
    JOIN app.aml_control_approvals approval ON approval.control_version_id = control.id
    WHERE control.id = target_control AND control.requires_acknowledgement
      AND control.kind IN ('aml_policy', 'sanctions_policy', 'conflicts_policy',
        'client_care_policy', 'complaints_policy', 'confidentiality_policy',
        'data_protection_policy', 'retention_policy', 'information_security_policy', 'finance_policy')
    FOR SHARE OF control, approval;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an approved acknowledgement policy is required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.policy_acknowledgements(control_version_id, account_id)
    VALUES(target_control, actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END;
$$;
REVOKE ALL ON FUNCTION app.acknowledge_policy(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.acknowledge_policy(uuid, uuid) TO pms_app;
