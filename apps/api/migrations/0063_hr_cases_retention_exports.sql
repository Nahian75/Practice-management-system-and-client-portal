-- People / HR step 16e: membership-scoped confidential cases, category retention,
-- legal holds, controlled disposal and reviewed fixed exports.

CREATE TABLE app.hr_cases (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES app.hr_people(id),
  kind text NOT NULL,
  raised_by_person_id uuid REFERENCES app.hr_people(id),
  policy_version text NOT NULL,
  due_on date,
  issue_context text NOT NULL UNIQUE,
  issue_key_version smallint NOT NULL,
  issue_nonce bytea NOT NULL,
  issue_ciphertext bytea NOT NULL,
  issue_auth_tag bytea NOT NULL,
  opened_by uuid NOT NULL REFERENCES app.accounts(id),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_case_kind_valid CHECK (kind IN ('grievance','disciplinary','capability')),
  CONSTRAINT hr_case_policy_safe CHECK (app.is_safe_text(policy_version) AND length(policy_version) BETWEEN 1 AND 200),
  CONSTRAINT hr_case_due_valid CHECK (due_on IS NULL OR due_on BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  CONSTRAINT hr_case_issue_crypto CHECK (issue_key_version > 0 AND octet_length(issue_nonce)=12
    AND octet_length(issue_auth_tag)=16 AND octet_length(issue_ciphertext) BETWEEN 2 AND 100000),
  CONSTRAINT hr_case_issue_context CHECK (issue_context='hr-case:' || id::text)
);
CREATE INDEX hr_cases_person_idx ON app.hr_cases(person_id,id DESC);

CREATE TABLE app.hr_case_memberships (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES app.hr_cases(id),
  account_id uuid NOT NULL REFERENCES app.accounts(id),
  role text NOT NULL,
  override_context text UNIQUE,
  override_key_version smallint,
  override_nonce bytea,
  override_ciphertext bytea,
  override_auth_tag bytea,
  added_by uuid NOT NULL REFERENCES app.accounts(id),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_case_member_role_valid CHECK (role IN ('hr_member','investigator','decision_maker','appeal_officer')),
  CONSTRAINT hr_case_member_override_crypto CHECK (
    (override_context IS NULL AND override_key_version IS NULL AND override_nonce IS NULL
      AND override_ciphertext IS NULL AND override_auth_tag IS NULL)
    OR (override_context='hr-case-role-override:' || id::text AND override_key_version > 0
      AND octet_length(override_nonce)=12 AND octet_length(override_auth_tag)=16
      AND octet_length(override_ciphertext) BETWEEN 2 AND 20000)
  )
);
CREATE INDEX hr_case_memberships_case_idx ON app.hr_case_memberships(case_id,added_at,id);
CREATE INDEX hr_case_memberships_account_idx ON app.hr_case_memberships(account_id,case_id);

CREATE TABLE app.hr_case_membership_endings (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL UNIQUE REFERENCES app.hr_case_memberships(id),
  reason_context text NOT NULL UNIQUE,
  reason_key_version smallint NOT NULL,
  reason_nonce bytea NOT NULL,
  reason_ciphertext bytea NOT NULL,
  reason_auth_tag bytea NOT NULL,
  ended_by uuid NOT NULL REFERENCES app.accounts(id),
  ended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_case_member_end_crypto CHECK (reason_key_version > 0 AND octet_length(reason_nonce)=12
    AND octet_length(reason_auth_tag)=16 AND octet_length(reason_ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT hr_case_member_end_context CHECK (reason_context='hr-case-membership-ending:' || id::text)
);

CREATE TABLE app.hr_case_events (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES app.hr_cases(id),
  kind text NOT NULL,
  state text,
  occurred_on date NOT NULL,
  supersedes_event_id uuid REFERENCES app.hr_case_events(id),
  context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_case_event_kind_valid CHECK (kind IN ('evidence','meeting','response','notice','outcome','action','appeal','correction','status')),
  CONSTRAINT hr_case_event_state_valid CHECK (
    (kind='status' AND state IN ('open','investigating','decision_due','appeal_open','closed'))
    OR (kind<>'status' AND state IS NULL)
  ),
  CONSTRAINT hr_case_event_correction_valid CHECK ((kind='correction')=(supersedes_event_id IS NOT NULL)),
  CONSTRAINT hr_case_event_date_valid CHECK (occurred_on BETWEEN DATE '1900-01-01' AND app.london_today()),
  CONSTRAINT hr_case_event_crypto CHECK (key_version > 0 AND octet_length(nonce)=12
    AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 100000),
  CONSTRAINT hr_case_event_context CHECK (context='hr-case-event:' || id::text)
);
CREATE INDEX hr_case_events_case_idx ON app.hr_case_events(case_id,recorded_at,id);

CREATE TABLE app.hr_case_access_log (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES app.hr_cases(id),
  action text NOT NULL,
  accessed_by uuid NOT NULL REFERENCES app.accounts(id),
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_case_access_action_valid CHECK (action IN ('view','export'))
);
CREATE INDEX hr_case_access_case_idx ON app.hr_case_access_log(case_id,accessed_at DESC,id DESC);

CREATE TABLE app.hr_retention_rules (
  id uuid PRIMARY KEY,
  category text NOT NULL,
  version integer NOT NULL,
  effective_from date NOT NULL,
  review_after_months smallint NOT NULL,
  retain_months smallint NOT NULL,
  governing_rule text NOT NULL,
  rationale_context text NOT NULL UNIQUE,
  rationale_key_version smallint NOT NULL,
  rationale_nonce bytea NOT NULL,
  rationale_ciphertext bytea NOT NULL,
  rationale_auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(category,version),
  CONSTRAINT hr_retention_rule_category CHECK (category IN ('personal','employment','leave','health','right_to_work','competence','case')),
  CONSTRAINT hr_retention_rule_period CHECK (review_after_months BETWEEN 1 AND retain_months AND retain_months BETWEEN 1 AND 1200
    AND (category<>'leave' OR retain_months>=72) AND (category<>'right_to_work' OR retain_months>=24)),
  CONSTRAINT hr_retention_rule_effective CHECK (effective_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  CONSTRAINT hr_retention_rule_text CHECK (app.is_safe_text(governing_rule) AND length(governing_rule) BETWEEN 10 AND 500),
  CONSTRAINT hr_retention_rule_crypto CHECK (rationale_key_version > 0 AND octet_length(rationale_nonce)=12
    AND octet_length(rationale_auth_tag)=16 AND octet_length(rationale_ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT hr_retention_rule_context CHECK (rationale_context='hr-retention-rule:' || id::text)
);
CREATE INDEX hr_retention_rules_category_idx ON app.hr_retention_rules(category,version DESC);

CREATE TABLE app.hr_retention_schedules (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES app.hr_people(id),
  rule_id uuid NOT NULL REFERENCES app.hr_retention_rules(id),
  category text NOT NULL,
  source_id uuid,
  basis_on date NOT NULL,
  review_on date NOT NULL,
  dispose_after date NOT NULL,
  evidence_context text NOT NULL UNIQUE,
  evidence_key_version smallint NOT NULL,
  evidence_nonce bytea NOT NULL,
  evidence_ciphertext bytea NOT NULL,
  evidence_auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_retention_schedule_category CHECK (category IN ('personal','employment','leave','health','right_to_work','competence','case')),
  CONSTRAINT hr_retention_schedule_source CHECK ((category='case')=(source_id IS NOT NULL)),
  CONSTRAINT hr_retention_schedule_dates CHECK (basis_on BETWEEN DATE '1900-01-01' AND app.london_today()
    AND review_on >= basis_on AND dispose_after >= review_on),
  CONSTRAINT hr_retention_schedule_crypto CHECK (evidence_key_version > 0 AND octet_length(evidence_nonce)=12
    AND octet_length(evidence_auth_tag)=16 AND octet_length(evidence_ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT hr_retention_schedule_context CHECK (evidence_context='hr-retention-schedule:' || id::text)
);
CREATE UNIQUE INDEX hr_retention_schedule_target_unique ON app.hr_retention_schedules
  (person_id,category,COALESCE(source_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX hr_retention_schedules_due_idx ON app.hr_retention_schedules(dispose_after,id);

CREATE TABLE app.hr_legal_hold_events (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES app.hr_retention_schedules(id),
  action text NOT NULL,
  review_on date,
  context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_legal_hold_action CHECK (action IN ('imposed','reviewed','released')),
  CONSTRAINT hr_legal_hold_review CHECK ((action IN ('imposed','reviewed') AND review_on IS NOT NULL) OR (action='released' AND review_on IS NULL)),
  CONSTRAINT hr_legal_hold_crypto CHECK (key_version > 0 AND octet_length(nonce)=12
    AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT hr_legal_hold_context CHECK (context='hr-legal-hold:' || id::text)
);
CREATE INDEX hr_legal_hold_schedule_idx ON app.hr_legal_hold_events(schedule_id,recorded_at DESC,id DESC);

CREATE FUNCTION app.is_safe_hr_storage_keys(value text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT value IS NOT NULL AND cardinality(value)<=10000 AND NOT EXISTS
    (SELECT 1 FROM unnest(value) key WHERE key IS NULL OR key !~ '^hr/[0-9a-f-]{36}$')
$$;
REVOKE ALL ON FUNCTION app.is_safe_hr_storage_keys(text[]) FROM PUBLIC;

CREATE TABLE app.hr_disposal_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL UNIQUE,
  person_id uuid NOT NULL,
  category text NOT NULL,
  rule_version integer NOT NULL,
  governing_rule text NOT NULL,
  state text NOT NULL,
  object_keys text[] NOT NULL,
  prepared_by uuid NOT NULL REFERENCES app.accounts(id),
  prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_by uuid REFERENCES app.accounts(id),
  completed_at timestamptz,
  record_count integer,
  CONSTRAINT hr_disposal_state CHECK (
    (state='prepared' AND completed_by IS NULL AND completed_at IS NULL AND record_count IS NULL)
    OR (state='completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND record_count>=0 AND cardinality(object_keys)=0)),
  CONSTRAINT hr_disposal_category CHECK (category IN ('personal','employment','leave','health','right_to_work','competence','case')),
  CONSTRAINT hr_disposal_keys CHECK (app.is_safe_hr_storage_keys(object_keys))
);

CREATE TABLE app.hr_disposed_records (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id uuid NOT NULL REFERENCES app.hr_disposal_runs(id),
  record_id uuid NOT NULL,
  record_kind text NOT NULL,
  category text NOT NULL,
  rule_version integer NOT NULL,
  disposed_by uuid NOT NULL REFERENCES app.accounts(id),
  disposed_at timestamptz NOT NULL,
  UNIQUE(run_id,record_kind,record_id),
  CONSTRAINT hr_disposed_kind CHECK (record_kind ~ '^hr_[a-z_]{2,80}$'),
  CONSTRAINT hr_disposed_category CHECK (category IN ('personal','employment','leave','health','right_to_work','competence','case'))
);

CREATE TABLE app.hr_exports (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES app.hr_people(id),
  purpose text NOT NULL,
  scopes text[] NOT NULL,
  case_ids uuid[] NOT NULL,
  context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  sha256 bytea NOT NULL,
  byte_size integer NOT NULL,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_export_purpose CHECK (purpose IN ('worker_access','litigation','regulator')),
  CONSTRAINT hr_export_scopes CHECK (cardinality(scopes) BETWEEN 1 AND 7 AND scopes <@ ARRAY['personal','employment','leave','health','vetting','competence','cases']::text[]),
  CONSTRAINT hr_export_cases CHECK (cardinality(case_ids)<=1000 AND (('cases'=ANY(scopes)) OR cardinality(case_ids)=0)),
  CONSTRAINT hr_export_crypto CHECK (key_version > 0 AND octet_length(nonce)=12
    AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 10000000),
  CONSTRAINT hr_export_context CHECK (context='hr-export:' || id::text),
  CONSTRAINT hr_export_hash CHECK (octet_length(sha256)=32 AND byte_size BETWEEN 2 AND 10000000)
);
CREATE INDEX hr_exports_person_idx ON app.hr_exports(person_id,id DESC);

CREATE TABLE app.hr_export_decisions (
  id uuid PRIMARY KEY,
  export_id uuid NOT NULL UNIQUE REFERENCES app.hr_exports(id),
  decision text NOT NULL,
  context text NOT NULL UNIQUE,
  key_version smallint NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  decided_by uuid NOT NULL REFERENCES app.accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_export_decision CHECK (decision IN ('approved','rejected')),
  CONSTRAINT hr_export_decision_crypto CHECK (key_version > 0 AND octet_length(nonce)=12
    AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 20000),
  CONSTRAINT hr_export_decision_context CHECK (context='hr-export-decision:' || id::text)
);

CREATE TABLE app.hr_export_access_log (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  export_id uuid NOT NULL REFERENCES app.hr_exports(id),
  accessed_by uuid NOT NULL REFERENCES app.accounts(id),
  accessed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON app.hr_cases,app.hr_case_memberships,app.hr_case_membership_endings,
  app.hr_case_events,app.hr_case_access_log,app.hr_retention_rules,app.hr_retention_schedules,
  app.hr_legal_hold_events,app.hr_disposal_runs,app.hr_disposed_records,app.hr_exports,
  app.hr_export_decisions,app.hr_export_access_log FROM pms_app;

-- Existing HR history remains immutable except inside the protected disposal function.
CREATE OR REPLACE FUNCTION app.refuse_hr_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.hr_disposal',true)='1' AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF current_setting('app.hr_disposal',true)='1' AND TG_OP='UPDATE' AND TG_TABLE_NAME='hr_disposal_runs' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'HR history is immutable' USING ERRCODE='insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_hr_history_change() FROM PUBLIC;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hr_cases','hr_case_memberships','hr_case_membership_endings','hr_case_events','hr_case_access_log',
    'hr_retention_rules','hr_retention_schedules','hr_legal_hold_events','hr_disposal_runs','hr_disposed_records',
    'hr_exports','hr_export_decisions','hr_export_access_log'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_hr_insert()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_hr_history_change()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_hr_truncate()',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.assert_hr_case_member(target_case uuid,actor_id uuid,required_role text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts WHERE id=actor_id AND kind='staff' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM 1 FROM app.hr_cases WHERE id=target_case FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.hr_case_memberships m
    WHERE m.case_id=target_case AND m.account_id=actor_id
      AND (required_role IS NULL OR m.role=required_role)
      AND (m.role<>'hr_member' OR EXISTS (SELECT 1 FROM app.account_roles r
        WHERE r.account_id=actor_id AND r.role='hr' AND r.revoked_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case membership required' USING ERRCODE='insufficient_privilege'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_hr_case_member(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION app.create_hr_case(target_id uuid,target_person uuid,selected_kind text,raiser_person uuid,
  selected_policy text,selected_due date,issue_context text,issue_key_version smallint,issue_nonce bytea,
  issue_ciphertext bytea,issue_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE member_id uuid:=uuidv7();
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF raiser_person IS NOT NULL THEN PERFORM 1 FROM app.hr_people WHERE id=raiser_person FOR SHARE;
    IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_cases(id,person_id,kind,raised_by_person_id,policy_version,due_on,
    issue_context,issue_key_version,issue_nonce,issue_ciphertext,issue_auth_tag,opened_by)
  VALUES(target_id,target_person,selected_kind,raiser_person,selected_policy,selected_due,
    issue_context,issue_key_version,issue_nonce,issue_ciphertext,issue_auth_tag,actor_id);
  INSERT INTO app.hr_case_memberships(id,case_id,account_id,role,added_by)
    VALUES(member_id,target_id,actor_id,'hr_member',actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_case(uuid,uuid,text,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_case(uuid,uuid,text,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.add_hr_case_member(target_id uuid,target_case uuid,target_account uuid,selected_role text,
  override_context text,override_key_version smallint,override_nonce bytea,override_ciphertext bytea,
  override_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE conflict_exists boolean;
BEGIN
  PERFORM app.assert_hr_case_member(target_case,actor_id,'hr_member');
  PERFORM 1 FROM app.hr_cases WHERE id=target_case FOR UPDATE;
  PERFORM 1 FROM app.accounts WHERE id=target_account AND kind='staff' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case member must be active staff' USING ERRCODE='check_violation'; END IF;
  IF selected_role='hr_member' THEN
    PERFORM 1 FROM app.account_roles WHERE account_id=target_account AND role='hr' AND revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'HR case member must hold the live HR role' USING ERRCODE='check_violation'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM app.hr_case_memberships m WHERE m.case_id=target_case AND m.account_id=target_account
      AND m.role=selected_role AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)) THEN
    RAISE EXCEPTION 'case membership already active' USING ERRCODE='unique_violation';
  END IF;
  conflict_exists:=selected_role IN ('investigator','decision_maker','appeal_officer') AND EXISTS(
    SELECT 1 FROM app.hr_case_memberships m WHERE m.case_id=target_case AND m.account_id=target_account
      AND m.role IN ('investigator','decision_maker','appeal_officer') AND m.role<>selected_role
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id));
  IF conflict_exists<>(override_context IS NOT NULL) THEN
    RAISE EXCEPTION 'role separation override does not match the assignment' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_case_memberships(id,case_id,account_id,role,override_context,override_key_version,
    override_nonce,override_ciphertext,override_auth_tag,added_by)
  VALUES(target_id,target_case,target_account,selected_role,override_context,override_key_version,
    override_nonce,override_ciphertext,override_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.add_hr_case_member(uuid,uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_hr_case_member(uuid,uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.end_hr_case_member(target_id uuid,target_membership uuid,reason_context text,
  reason_key_version smallint,reason_nonce bytea,reason_ciphertext bytea,reason_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE membership app.hr_case_memberships;
BEGIN
  SELECT * INTO membership FROM app.hr_case_memberships WHERE id=target_membership FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM app.assert_hr_case_member(membership.case_id,actor_id,'hr_member');
  PERFORM 1 FROM app.hr_cases WHERE id=membership.case_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.hr_case_membership_endings WHERE membership_id=membership.id) THEN
    RAISE EXCEPTION 'case membership already ended' USING ERRCODE='unique_violation';
  END IF;
  IF membership.role='hr_member' AND NOT EXISTS (
    SELECT 1 FROM app.hr_case_memberships m JOIN app.accounts a ON a.id=m.account_id
      WHERE m.case_id=membership.case_id AND m.role='hr_member' AND m.id<>membership.id
      AND a.kind='staff' AND a.status='active' AND EXISTS (SELECT 1 FROM app.account_roles r
        WHERE r.account_id=m.account_id AND r.role='hr' AND r.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)) THEN
    RAISE EXCEPTION 'a case must retain an HR member' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_case_membership_endings(id,membership_id,reason_context,reason_key_version,
    reason_nonce,reason_ciphertext,reason_auth_tag,ended_by)
  VALUES(target_id,target_membership,reason_context,reason_key_version,reason_nonce,reason_ciphertext,reason_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.end_hr_case_member(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_hr_case_member(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_case_event(target_id uuid,target_case uuid,selected_kind text,selected_state text,
  selected_on date,superseded uuid,selected_context text,selected_key_version smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF selected_kind IN ('outcome') THEN PERFORM app.assert_hr_case_member(target_case,actor_id,'decision_maker');
  ELSIF selected_kind='appeal' THEN PERFORM app.assert_hr_case_member(target_case,actor_id,'appeal_officer');
  ELSIF selected_kind='status' THEN PERFORM app.assert_hr_case_member(target_case,actor_id,'hr_member');
  ELSE PERFORM app.assert_hr_case_member(target_case,actor_id,NULL); END IF;
  PERFORM 1 FROM app.hr_cases WHERE id=target_case FOR UPDATE;
  IF superseded IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.hr_case_events WHERE id=superseded AND case_id=target_case AND kind<>'correction') THEN
    RAISE EXCEPTION 'the corrected event is not part of this case' USING ERRCODE='check_violation';
  END IF;
  IF selected_kind='appeal' AND COALESCE((SELECT state FROM app.hr_case_events WHERE case_id=target_case AND kind='status'
      ORDER BY recorded_at DESC,id DESC LIMIT 1),'open')<>'closed' THEN
    RAISE EXCEPTION 'an appeal follows a closed decision' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_case_events(id,case_id,kind,state,occurred_on,supersedes_event_id,context,key_version,
    nonce,ciphertext,auth_tag,recorded_by)
  VALUES(target_id,target_case,selected_kind,selected_state,selected_on,superseded,selected_context,
    selected_key_version,selected_nonce,selected_ciphertext,selected_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_case_event(uuid,uuid,text,text,date,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_case_event(uuid,uuid,text,text,date,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_cases(actor_id uuid)
  RETURNS TABLE(id uuid,person_id uuid,kind text,due_on date,state text,opened_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts a WHERE a.id=actor_id AND a.kind='staff' AND a.status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN QUERY SELECT c.id,c.person_id,c.kind,c.due_on,COALESCE((SELECT e.state FROM app.hr_case_events e
    WHERE e.case_id=c.id AND e.kind='status' ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),'open'),c.opened_at
  FROM app.hr_cases c WHERE EXISTS (SELECT 1 FROM app.hr_case_memberships m WHERE m.case_id=c.id
    AND m.account_id=actor_id AND (m.role<>'hr_member' OR EXISTS (SELECT 1 FROM app.account_roles r
      WHERE r.account_id=actor_id AND r.role='hr' AND r.revoked_at IS NULL))
    AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings x WHERE x.membership_id=m.id))
  ORDER BY c.id DESC LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_cases(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_cases(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_case(target_case uuid,actor_id uuid,access_kind text)
  RETURNS SETOF app.hr_cases LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_case_member(target_case,actor_id,NULL);
  IF access_kind NOT IN ('view','export') THEN RAISE EXCEPTION 'invalid case access kind' USING ERRCODE='check_violation'; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_case_access_log(case_id,action,accessed_by) VALUES(target_case,access_kind,actor_id);
  RETURN QUERY SELECT * FROM app.hr_cases WHERE id=target_case;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_case(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_case(uuid,uuid,text) TO pms_app;

CREATE FUNCTION app.read_hr_case_members(target_case uuid,actor_id uuid)
  RETURNS TABLE(id uuid,account_id uuid,role text,override_context text,override_key_version smallint,
    override_nonce bytea,override_ciphertext bytea,override_auth_tag bytea,added_by uuid,added_at timestamptz,
    ending_id uuid,reason_context text,reason_key_version smallint,reason_nonce bytea,reason_ciphertext bytea,
    reason_auth_tag bytea,ended_by uuid,ended_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_case_member(target_case,actor_id,NULL);
  RETURN QUERY SELECT m.id,m.account_id,m.role,m.override_context,m.override_key_version,m.override_nonce,
    m.override_ciphertext,m.override_auth_tag,m.added_by,m.added_at,e.id,e.reason_context,e.reason_key_version,
    e.reason_nonce,e.reason_ciphertext,e.reason_auth_tag,e.ended_by,e.ended_at
  FROM app.hr_case_memberships m LEFT JOIN app.hr_case_membership_endings e ON e.membership_id=m.id
  WHERE m.case_id=target_case ORDER BY m.added_at,m.id;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_case_members(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_case_members(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_case_events(target_case uuid,actor_id uuid)
  RETURNS SETOF app.hr_case_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_case_member(target_case,actor_id,NULL);
  RETURN QUERY SELECT * FROM app.hr_case_events WHERE case_id=target_case ORDER BY recorded_at,id;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_case_events(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_case_events(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_case_accesses(target_case uuid,actor_id uuid)
  RETURNS SETOF app.hr_case_access_log LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_case_member(target_case,actor_id,'hr_member');
  RETURN QUERY SELECT * FROM app.hr_case_access_log WHERE case_id=target_case ORDER BY accessed_at DESC,id DESC LIMIT 1000;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_case_accesses(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_case_accesses(uuid,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_retention_rule(target_id uuid,selected_category text,selected_effective date,
  selected_review smallint,selected_retain smallint,selected_rule text,rationale_context text,
  rationale_key_version smallint,rationale_nonce bytea,rationale_ciphertext bytea,rationale_auth_tag bytea,
  actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE next_version integer;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hr-retention-rule:' || selected_category,0));
  SELECT COALESCE(max(version),0)+1 INTO next_version FROM app.hr_retention_rules WHERE category=selected_category;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_retention_rules(id,category,version,effective_from,review_after_months,retain_months,
    governing_rule,rationale_context,rationale_key_version,rationale_nonce,rationale_ciphertext,rationale_auth_tag,recorded_by)
  VALUES(target_id,selected_category,next_version,selected_effective,selected_review,selected_retain,selected_rule,
    rationale_context,rationale_key_version,rationale_nonce,rationale_ciphertext,rationale_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_retention_rule(uuid,text,date,smallint,smallint,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_retention_rule(uuid,text,date,smallint,smallint,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.hr_retention_basis(target_person uuid,selected_category text,target_source uuid) RETURNS date
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE basis date; engagement_end date;
BEGIN
  IF selected_category='case' THEN
    SELECT e.occurred_on INTO basis FROM app.hr_case_events e
      JOIN app.hr_cases c ON c.id=e.case_id
      WHERE e.case_id=target_source AND c.person_id=target_person AND e.kind='status' AND e.state='closed'
        AND NOT EXISTS (SELECT 1 FROM app.hr_case_events later WHERE later.case_id=e.case_id AND later.kind='status'
          AND (later.recorded_at,later.id)>(e.recorded_at,e.id))
      ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1;
    RETURN basis;
  END IF;

  IF selected_category IN ('personal','employment','health','right_to_work','competence') THEN
    IF EXISTS (SELECT 1 FROM app.hr_engagements e WHERE e.person_id=target_person
      AND e.started_on<=app.london_today() AND (e.ended_on IS NULL OR e.ended_on>=app.london_today())) THEN RETURN NULL; END IF;
    SELECT max(e.ended_on) INTO engagement_end FROM app.hr_engagements e WHERE e.person_id=target_person;
    IF engagement_end IS NULL THEN RETURN NULL; END IF;
  END IF;

  IF selected_category IN ('employment','right_to_work') THEN RETURN engagement_end; END IF;
  IF selected_category='personal' THEN
    SELECT max(value) INTO basis FROM (VALUES (engagement_end),
      ((SELECT max(recorded_at)::date FROM app.hr_contact_versions WHERE person_id=target_person)),
      ((SELECT max(recorded_at)::date FROM app.hr_private_versions WHERE person_id=target_person)),
      ((SELECT max(submitted_at)::date FROM app.hr_correction_requests WHERE person_id=target_person)),
      ((SELECT max(uploaded_at)::date FROM app.hr_files WHERE person_id=target_person))) dates(value);
    RETURN basis;
  END IF;
  IF selected_category='leave' THEN
    SELECT max(value) INTO basis FROM (VALUES
      ((SELECT max(submitted_at)::date FROM app.hr_leave_requests WHERE person_id=target_person)),
      ((SELECT max(recorded_at)::date FROM app.hr_leave_entitlement_entries WHERE person_id=target_person)),
      ((SELECT max(recorded_at)::date FROM app.hr_holiday_pay_records WHERE person_id=target_person))) dates(value);
    RETURN basis;
  END IF;
  IF selected_category='health' THEN
    SELECT max(value) INTO basis FROM (VALUES (engagement_end),
      ((SELECT max(recorded_at)::date FROM app.hr_health_records WHERE person_id=target_person)),
      ((SELECT max(recorded_at)::date FROM app.hr_sickness_absences WHERE person_id=target_person)),
      ((SELECT max(submitted_at)::date FROM app.hr_adjustment_requests WHERE person_id=target_person))) dates(value);
    RETURN basis;
  END IF;
  IF selected_category='competence' THEN
    SELECT max(value) INTO basis FROM (VALUES (engagement_end),
      ((SELECT max(recorded_at)::date FROM app.hr_professional_records WHERE person_id=target_person)),
      ((SELECT max(created_at)::date FROM app.hr_development_cycles WHERE person_id=target_person)),
      ((SELECT max(assigned_at)::date FROM app.hr_learning_assignments WHERE person_id=target_person)),
      ((SELECT max(recorded_at)::date FROM app.hr_review_records WHERE person_id=target_person))) dates(value);
    RETURN basis;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.hr_retention_basis(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION app.create_hr_retention_schedule(target_id uuid,target_person uuid,target_rule uuid,target_source uuid,
  selected_basis date,evidence_context text,evidence_key_version smallint,evidence_nonce bytea,
  evidence_ciphertext bytea,evidence_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE selected app.hr_retention_rules; calculated_review date; calculated_disposal date; trusted_basis date;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR UPDATE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT * INTO selected FROM app.hr_retention_rules WHERE id=target_rule AND effective_from<=selected_basis FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention rule is not effective for this basis date' USING ERRCODE='check_violation'; END IF;
  IF selected.category='case' THEN
    PERFORM 1 FROM app.hr_cases c WHERE c.id=target_source AND c.person_id=target_person
      AND COALESCE((SELECT e.state FROM app.hr_case_events e WHERE e.case_id=c.id AND e.kind='status'
        ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1),'open')='closed' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'case retention starts only after the case is closed' USING ERRCODE='check_violation'; END IF;
  ELSIF target_source IS NOT NULL THEN RAISE EXCEPTION 'only a case schedule names a source record' USING ERRCODE='check_violation'; END IF;
  trusted_basis:=app.hr_retention_basis(target_person,selected.category,target_source);
  IF trusted_basis IS NULL OR selected_basis<>trusted_basis THEN
    RAISE EXCEPTION 'retention basis must match the latest protected source record' USING ERRCODE='check_violation';
  END IF;
  calculated_review:=(selected_basis+make_interval(months=>selected.review_after_months))::date;
  calculated_disposal:=(selected_basis+make_interval(months=>selected.retain_months))::date;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_retention_schedules(id,person_id,rule_id,category,source_id,basis_on,review_on,dispose_after,
    evidence_context,evidence_key_version,evidence_nonce,evidence_ciphertext,evidence_auth_tag,recorded_by)
  VALUES(target_id,target_person,target_rule,selected.category,target_source,selected_basis,calculated_review,calculated_disposal,
    evidence_context,evidence_key_version,evidence_nonce,evidence_ciphertext,evidence_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_retention_schedule(uuid,uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_retention_schedule(uuid,uuid,uuid,uuid,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_legal_hold(target_id uuid,target_schedule uuid,selected_action text,selected_review date,
  selected_context text,selected_key_version smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE current_action text;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_retention_schedules WHERE id=target_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT action INTO current_action FROM app.hr_legal_hold_events WHERE schedule_id=target_schedule
    ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF (selected_action='imposed' AND current_action IN ('imposed','reviewed'))
    OR (selected_action IN ('reviewed','released') AND COALESCE(current_action,'released')='released') THEN
    RAISE EXCEPTION 'legal hold transition is not valid' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_legal_hold_events(id,schedule_id,action,review_on,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
  VALUES(target_id,target_schedule,selected_action,selected_review,selected_context,selected_key_version,
    selected_nonce,selected_ciphertext,selected_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.record_hr_legal_hold(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_legal_hold(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_retention_rules(actor_id uuid) RETURNS SETOF app.hr_retention_rules
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_active_hr(actor_id); RETURN QUERY SELECT * FROM app.hr_retention_rules ORDER BY category,version DESC; END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_retention_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_retention_rules(uuid) TO pms_app;

CREATE FUNCTION app.list_hr_retention_schedules(actor_id uuid)
  RETURNS TABLE(id uuid,person_id uuid,rule_id uuid,category text,source_id uuid,basis_on date,review_on date,
    dispose_after date,rule_version integer,governing_rule text,hold_action text,hold_review_on date,recorded_by uuid,recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT s.id,s.person_id,s.rule_id,s.category,s.source_id,s.basis_on,s.review_on,s.dispose_after,
    r.version,r.governing_rule,h.action,h.review_on,s.recorded_by,s.recorded_at
  FROM app.hr_retention_schedules s JOIN app.hr_retention_rules r ON r.id=s.rule_id
  LEFT JOIN LATERAL (SELECT e.action,e.review_on FROM app.hr_legal_hold_events e WHERE e.schedule_id=s.id
    ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1) h ON true
  ORDER BY s.dispose_after,s.id LIMIT 1000;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_retention_schedules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_retention_schedules(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_retention_schedule(target_schedule uuid,actor_id uuid) RETURNS SETOF app.hr_retention_schedules
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_active_hr(actor_id); RETURN QUERY SELECT * FROM app.hr_retention_schedules WHERE id=target_schedule; END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_retention_schedule(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_retention_schedule(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_legal_holds(target_schedule uuid,actor_id uuid) RETURNS SETOF app.hr_legal_hold_events
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_active_hr(actor_id); RETURN QUERY SELECT * FROM app.hr_legal_hold_events WHERE schedule_id=target_schedule ORDER BY recorded_at,id; END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_legal_holds(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_legal_holds(uuid,uuid) TO pms_app;

CREATE FUNCTION app.prepare_hr_disposal(run_id uuid,target_schedule uuid,actor_id uuid)
  RETURNS TABLE(id uuid,object_keys text[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE schedule app.hr_retention_schedules; selected_rule app.hr_retention_rules; keys text[]:='{}'::text[];
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO schedule FROM app.hr_retention_schedules WHERE hr_retention_schedules.id=target_schedule FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT * INTO selected_rule FROM app.hr_retention_rules r WHERE r.id=schedule.rule_id FOR SHARE;
  PERFORM 1 FROM app.hr_people p WHERE p.id=schedule.person_id FOR UPDATE;
  IF schedule.category='case' THEN
    PERFORM 1 FROM app.hr_cases c WHERE c.id=schedule.source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  END IF;
  IF schedule.dispose_after>app.london_today() THEN RAISE EXCEPTION 'retention period has not ended' USING ERRCODE='check_violation'; END IF;
  IF app.hr_retention_basis(schedule.person_id,schedule.category,schedule.source_id) IS DISTINCT FROM schedule.basis_on THEN
    RAISE EXCEPTION 'newer records or an active engagement prevent disposal' USING ERRCODE='check_violation';
  END IF;
  IF COALESCE((SELECT h.action FROM app.hr_legal_hold_events h WHERE h.schedule_id=schedule.id
      ORDER BY h.recorded_at DESC,h.id DESC LIMIT 1),'released')<>'released' THEN
    RAISE EXCEPTION 'an active legal hold prevents disposal' USING ERRCODE='check_violation';
  END IF;
  IF schedule.category='employment' AND EXISTS (SELECT 1 FROM app.hr_right_to_work_checks WHERE person_id=schedule.person_id) THEN
    RAISE EXCEPTION 'right-to-work evidence must follow its own retention schedule first' USING ERRCODE='check_violation';
  END IF;
  IF schedule.category='right_to_work' THEN SELECT COALESCE(array_agg(DISTINCT f.storage_key),'{}'::text[]) INTO keys
    FROM app.hr_files f JOIN app.hr_right_to_work_checks r ON r.evidence_file_id=f.id WHERE r.person_id=schedule.person_id;
  ELSIF schedule.category='personal' THEN SELECT COALESCE(array_agg(f.storage_key),'{}'::text[]) INTO keys
    FROM app.hr_files f WHERE f.person_id=schedule.person_id AND NOT EXISTS
      (SELECT 1 FROM app.hr_right_to_work_checks r WHERE r.evidence_file_id=f.id);
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_disposal_runs(id,schedule_id,person_id,category,rule_version,governing_rule,state,object_keys,prepared_by)
  VALUES(run_id,schedule.id,schedule.person_id,schedule.category,selected_rule.version,selected_rule.governing_rule,'prepared',keys,actor_id)
  ON CONFLICT(schedule_id) DO NOTHING;
  RETURN QUERY SELECT r.id,r.object_keys FROM app.hr_disposal_runs r WHERE r.schedule_id=schedule.id AND r.state='prepared';
END;
$$;
REVOKE ALL ON FUNCTION app.prepare_hr_disposal(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_hr_disposal(uuid,uuid,uuid) TO pms_app;

CREATE FUNCTION app.finalize_hr_disposal(target_run uuid,actor_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE run app.hr_disposal_runs; schedule app.hr_retention_schedules; disposed_time timestamptz:=clock_timestamp();
DECLARE total integer:=0; added integer:=0;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO run FROM app.hr_disposal_runs WHERE id=target_run FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF run.state='completed' THEN RETURN run.record_count; END IF;
  SELECT * INTO schedule FROM app.hr_retention_schedules WHERE id=run.schedule_id FOR UPDATE;
  IF NOT FOUND OR schedule.dispose_after>app.london_today() THEN RAISE EXCEPTION 'record is not eligible for disposal' USING ERRCODE='check_violation'; END IF;
  IF app.hr_retention_basis(schedule.person_id,schedule.category,schedule.source_id) IS DISTINCT FROM schedule.basis_on THEN
    RAISE EXCEPTION 'newer records or an active engagement prevent disposal' USING ERRCODE='check_violation';
  END IF;
  PERFORM 1 FROM app.hr_people WHERE id=run.person_id FOR UPDATE;
  IF COALESCE((SELECT action FROM app.hr_legal_hold_events WHERE schedule_id=schedule.id
      ORDER BY recorded_at DESC,id DESC LIMIT 1),'released')<>'released' THEN
    RAISE EXCEPTION 'an active legal hold prevents disposal' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  PERFORM set_config('app.hr_disposal','1',true);

  -- A fixed export may contain any selected category, so disposal removes every
  -- bundle for this person rather than retaining an encrypted duplicate.
  INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
    SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
      SELECT e.id,'hr_export' kind FROM app.hr_exports e WHERE e.person_id=run.person_id
      UNION ALL SELECT d.id,'hr_export_decision' FROM app.hr_export_decisions d JOIN app.hr_exports e ON e.id=d.export_id WHERE e.person_id=run.person_id
      UNION ALL SELECT a.id,'hr_export_access' FROM app.hr_export_access_log a JOIN app.hr_exports e ON e.id=a.export_id WHERE e.person_id=run.person_id
    ) x;
  GET DIAGNOSTICS total=ROW_COUNT;
  DELETE FROM app.hr_export_access_log a USING app.hr_exports e WHERE a.export_id=e.id AND e.person_id=run.person_id;
  DELETE FROM app.hr_export_decisions d USING app.hr_exports e WHERE d.export_id=e.id AND e.person_id=run.person_id;
  DELETE FROM app.hr_exports WHERE person_id=run.person_id;

  IF run.category='case' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT c.id,'hr_case' kind FROM app.hr_cases c WHERE c.id=schedule.source_id
        UNION ALL SELECT e.id,'hr_case_event' FROM app.hr_case_events e WHERE e.case_id=schedule.source_id
        UNION ALL SELECT m.id,'hr_case_membership' FROM app.hr_case_memberships m WHERE m.case_id=schedule.source_id
        UNION ALL SELECT x.id,'hr_case_membership_ending' FROM app.hr_case_membership_endings x JOIN app.hr_case_memberships m ON m.id=x.membership_id WHERE m.case_id=schedule.source_id
        UNION ALL SELECT a.id,'hr_case_access' FROM app.hr_case_access_log a WHERE a.case_id=schedule.source_id
      ) x;
    GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_case_access_log WHERE case_id=schedule.source_id;
    DELETE FROM app.hr_case_membership_endings x USING app.hr_case_memberships m WHERE x.membership_id=m.id AND m.case_id=schedule.source_id;
    DELETE FROM app.hr_case_memberships WHERE case_id=schedule.source_id;
    DELETE FROM app.hr_case_events WHERE case_id=schedule.source_id;
    DELETE FROM app.hr_cases WHERE id=schedule.source_id;
  ELSIF run.category='health' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_health_record' kind FROM app.hr_health_records WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_sickness_absence' FROM app.hr_sickness_absences WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_adjustment_request' FROM app.hr_adjustment_requests WHERE person_id=run.person_id
        UNION ALL SELECT d.id,'hr_adjustment_decision' FROM app.hr_adjustment_decisions d JOIN app.hr_adjustment_requests r ON r.id=d.request_id WHERE r.person_id=run.person_id
        UNION ALL SELECT p.id,'hr_adjustment_progress' FROM app.hr_adjustment_progress_events p JOIN app.hr_adjustment_decisions d ON d.id=p.decision_id JOIN app.hr_adjustment_requests r ON r.id=d.request_id WHERE r.person_id=run.person_id
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_adjustment_progress_events p USING app.hr_adjustment_decisions d,app.hr_adjustment_requests r WHERE p.decision_id=d.id AND d.request_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_adjustment_decisions d USING app.hr_adjustment_requests r WHERE d.request_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_adjustment_requests WHERE person_id=run.person_id;
    DELETE FROM app.hr_health_records WHERE person_id=run.person_id;
    DELETE FROM app.hr_sickness_absences WHERE person_id=run.person_id;
  ELSIF run.category='leave' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_leave_request' kind FROM app.hr_leave_requests WHERE person_id=run.person_id
        UNION ALL SELECT e.id,'hr_leave_request_event' FROM app.hr_leave_request_events e JOIN app.hr_leave_requests r ON r.id=e.request_id WHERE r.person_id=run.person_id
        UNION ALL SELECT id,'hr_leave_request_day' FROM app.hr_leave_request_days WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_leave_entitlement_entry' FROM app.hr_leave_entitlement_entries WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_holiday_pay_record' FROM app.hr_holiday_pay_records WHERE person_id=run.person_id
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_holiday_pay_records WHERE person_id=run.person_id;
    DELETE FROM app.hr_leave_entitlement_entries WHERE person_id=run.person_id;
    DELETE FROM app.hr_leave_request_days WHERE person_id=run.person_id;
    DELETE FROM app.hr_leave_request_events e USING app.hr_leave_requests r WHERE e.request_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_leave_requests WHERE person_id=run.person_id;
  ELSIF run.category='right_to_work' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_right_to_work_check' kind FROM app.hr_right_to_work_checks WHERE person_id=run.person_id
        UNION ALL SELECT f.id,'hr_file' FROM app.hr_files f JOIN app.hr_right_to_work_checks r ON r.evidence_file_id=f.id WHERE r.person_id=run.person_id
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_right_to_work_checks WHERE person_id=run.person_id;
    DELETE FROM app.hr_files f WHERE f.person_id=run.person_id AND f.storage_key=ANY(run.object_keys);
  ELSIF run.category='competence' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_professional_record' kind FROM app.hr_professional_records WHERE person_id=run.person_id
        UNION ALL SELECT c.id,'hr_professional_check' FROM app.hr_professional_check_events c JOIN app.hr_professional_records r ON r.id=c.record_id WHERE r.person_id=run.person_id
        UNION ALL SELECT id,'hr_development_cycle' FROM app.hr_development_cycles WHERE person_id=run.person_id
        UNION ALL SELECT e.id,'hr_development_event' FROM app.hr_development_events e JOIN app.hr_development_cycles c ON c.id=e.cycle_id WHERE c.person_id=run.person_id
        UNION ALL SELECT id,'hr_learning_assignment' FROM app.hr_learning_assignments WHERE person_id=run.person_id
        UNION ALL SELECT e.id,'hr_learning_event' FROM app.hr_learning_events e JOIN app.hr_learning_assignments a ON a.id=e.assignment_id WHERE a.person_id=run.person_id
        UNION ALL SELECT id,'hr_review_record' FROM app.hr_review_records WHERE person_id=run.person_id
        UNION ALL SELECT e.id,'hr_review_worker_event' FROM app.hr_review_worker_events e JOIN app.hr_review_records r ON r.id=e.review_id WHERE r.person_id=run.person_id
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_professional_check_events e USING app.hr_professional_records r WHERE e.record_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_professional_records WHERE person_id=run.person_id;
    DELETE FROM app.hr_development_events e USING app.hr_development_cycles c WHERE e.cycle_id=c.id AND c.person_id=run.person_id;
    DELETE FROM app.hr_development_cycles WHERE person_id=run.person_id;
    DELETE FROM app.hr_learning_events e USING app.hr_learning_assignments a WHERE e.assignment_id=a.id AND a.person_id=run.person_id;
    DELETE FROM app.hr_learning_assignments WHERE person_id=run.person_id;
    DELETE FROM app.hr_review_worker_events e USING app.hr_review_records r WHERE e.review_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_review_records WHERE person_id=run.person_id;
  ELSIF run.category='personal' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_contact_version' kind FROM app.hr_contact_versions WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_private_version' FROM app.hr_private_versions WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_correction_request' FROM app.hr_correction_requests WHERE person_id=run.person_id
        UNION ALL SELECT e.id,'hr_correction_event' FROM app.hr_correction_events e JOIN app.hr_correction_requests r ON r.id=e.request_id WHERE r.person_id=run.person_id
        UNION ALL SELECT f.id,'hr_file' FROM app.hr_files f WHERE f.person_id=run.person_id AND f.storage_key=ANY(run.object_keys)
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_correction_events e USING app.hr_correction_requests r WHERE e.request_id=r.id AND r.person_id=run.person_id;
    DELETE FROM app.hr_correction_requests WHERE person_id=run.person_id;
    DELETE FROM app.hr_contact_versions WHERE person_id=run.person_id;
    DELETE FROM app.hr_private_versions WHERE person_id=run.person_id;
    DELETE FROM app.hr_files f WHERE f.person_id=run.person_id AND f.storage_key=ANY(run.object_keys);
  ELSIF run.category='employment' THEN
    INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
      SELECT run.id,x.id,x.kind,run.category,run.rule_version,actor_id,disposed_time FROM (
        SELECT id,'hr_engagement' kind FROM app.hr_engagements WHERE person_id=run.person_id
        UNION ALL SELECT t.id,'hr_employment_terms' FROM app.hr_employment_terms t JOIN app.hr_engagements e ON e.id=t.engagement_id WHERE e.person_id=run.person_id
        UNION ALL SELECT w.id,'hr_work_pattern' FROM app.hr_work_patterns w JOIN app.hr_engagements e ON e.id=w.engagement_id WHERE e.person_id=run.person_id
        UNION ALL SELECT x.id,'hr_engagement_ending' FROM app.hr_engagement_endings x JOIN app.hr_engagements e ON e.id=x.engagement_id WHERE e.person_id=run.person_id
        UNION ALL SELECT id,'hr_manager_event' FROM app.hr_manager_events WHERE person_id=run.person_id
        UNION ALL SELECT id,'hr_lifecycle_checklist' FROM app.hr_lifecycle_checklists WHERE person_id=run.person_id
      ) x; GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
    DELETE FROM app.hr_lifecycle_item_events x USING app.hr_lifecycle_items i,app.hr_lifecycle_checklists c WHERE x.item_id=i.id AND i.checklist_id=c.id AND c.person_id=run.person_id;
    DELETE FROM app.hr_lifecycle_checklist_events x USING app.hr_lifecycle_checklists c WHERE x.checklist_id=c.id AND c.person_id=run.person_id;
    DELETE FROM app.hr_lifecycle_items i USING app.hr_lifecycle_checklists c WHERE i.checklist_id=c.id AND c.person_id=run.person_id;
    DELETE FROM app.hr_lifecycle_checklists WHERE person_id=run.person_id;
    DELETE FROM app.hr_employment_terms t USING app.hr_engagements e WHERE t.engagement_id=e.id AND e.person_id=run.person_id;
    DELETE FROM app.hr_work_patterns w USING app.hr_engagements e WHERE w.engagement_id=e.id AND e.person_id=run.person_id;
    DELETE FROM app.hr_engagement_endings x USING app.hr_engagements e WHERE x.engagement_id=e.id AND e.person_id=run.person_id;
    DELETE FROM app.hr_manager_events WHERE person_id=run.person_id;
    DELETE FROM app.hr_engagements WHERE person_id=run.person_id;
  END IF;

  INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
    SELECT run.id,id,'hr_legal_hold_event',run.category,run.rule_version,actor_id,disposed_time
      FROM app.hr_legal_hold_events WHERE schedule_id=schedule.id;
  GET DIAGNOSTICS added=ROW_COUNT; total:=total+added;
  INSERT INTO app.hr_disposed_records(run_id,record_id,record_kind,category,rule_version,disposed_by,disposed_at)
    VALUES(run.id,schedule.id,'hr_retention_schedule',run.category,run.rule_version,actor_id,disposed_time);
  total:=total+1;
  DELETE FROM app.hr_legal_hold_events WHERE schedule_id=schedule.id;
  DELETE FROM app.hr_retention_schedules WHERE id=schedule.id;
  UPDATE app.hr_disposal_runs SET state='completed',object_keys='{}'::text[],completed_by=actor_id,
    completed_at=disposed_time,record_count=total WHERE id=run.id;
  RETURN total;
END;
$$;
REVOKE ALL ON FUNCTION app.finalize_hr_disposal(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finalize_hr_disposal(uuid,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_disposals(actor_id uuid) RETURNS SETOF app.hr_disposal_runs
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_active_hr(actor_id); RETURN QUERY SELECT * FROM app.hr_disposal_runs ORDER BY id DESC LIMIT 1000; END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_disposals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_disposals(uuid) TO pms_app;

CREATE FUNCTION app.create_hr_export(target_id uuid,target_person uuid,selected_purpose text,selected_scopes text[],
  selected_case_ids uuid[],selected_context text,selected_key_version smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_auth_tag bytea,selected_sha bytea,selected_size integer,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE case_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE; IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  FOREACH case_id IN ARRAY selected_case_ids LOOP
    PERFORM app.assert_hr_case_member(case_id,actor_id,NULL);
    PERFORM 1 FROM app.hr_cases WHERE id=case_id AND person_id=target_person;
    IF NOT FOUND THEN RAISE EXCEPTION 'export case does not belong to the worker' USING ERRCODE='check_violation'; END IF;
  END LOOP;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_exports(id,person_id,purpose,scopes,case_ids,context,key_version,nonce,ciphertext,auth_tag,
    sha256,byte_size,created_by)
  VALUES(target_id,target_person,selected_purpose,selected_scopes,selected_case_ids,selected_context,
    selected_key_version,selected_nonce,selected_ciphertext,selected_auth_tag,selected_sha,selected_size,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_hr_export(uuid,uuid,text,text[],uuid[],text,smallint,bytea,bytea,bytea,bytea,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_export(uuid,uuid,text,text[],uuid[],text,smallint,bytea,bytea,bytea,bytea,integer,uuid) TO pms_app;

CREATE FUNCTION app.decide_hr_export(target_id uuid,target_export uuid,selected_decision text,selected_context text,
  selected_key_version smallint,selected_nonce bytea,selected_ciphertext bytea,selected_auth_tag bytea,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE selected app.hr_exports; case_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO selected FROM app.hr_exports WHERE id=target_export FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected.created_by=actor_id THEN RAISE EXCEPTION 'export reviewer must differ from preparer' USING ERRCODE='check_violation'; END IF;
  FOREACH case_id IN ARRAY selected.case_ids LOOP PERFORM app.assert_hr_case_member(case_id,actor_id,NULL); END LOOP;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_export_decisions(id,export_id,decision,context,key_version,nonce,ciphertext,auth_tag,decided_by)
  VALUES(target_id,target_export,selected_decision,selected_context,selected_key_version,selected_nonce,
    selected_ciphertext,selected_auth_tag,actor_id);
  RETURN target_id;
END;
$$;
REVOKE ALL ON FUNCTION app.decide_hr_export(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_hr_export(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_exports(actor_id uuid)
  RETURNS TABLE(id uuid,person_id uuid,purpose text,scopes text[],case_ids uuid[],sha256 bytea,byte_size integer,
    created_by uuid,created_at timestamptz,decision text,decided_by uuid,decided_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT e.id,e.person_id,e.purpose,e.scopes,e.case_ids,e.sha256,e.byte_size,e.created_by,e.created_at,
    d.decision,d.decided_by,d.decided_at FROM app.hr_exports e LEFT JOIN app.hr_export_decisions d ON d.export_id=e.id
  WHERE NOT EXISTS (SELECT 1 FROM unnest(e.case_ids) case_id WHERE NOT EXISTS (
    SELECT 1 FROM app.hr_case_memberships m WHERE m.case_id=case_id AND m.account_id=actor_id
      AND (m.role<>'hr_member' OR EXISTS (SELECT 1 FROM app.account_roles r
        WHERE r.account_id=actor_id AND r.role='hr' AND r.revoked_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings x WHERE x.membership_id=m.id)))
  ORDER BY e.id DESC LIMIT 1000;
END;
$$;
REVOKE ALL ON FUNCTION app.list_hr_exports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_exports(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_export(target_export uuid,actor_id uuid,download boolean)
  RETURNS SETOF app.hr_exports LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE selected app.hr_exports; case_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO selected FROM app.hr_exports WHERE id=target_export FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  FOREACH case_id IN ARRAY selected.case_ids LOOP PERFORM app.assert_hr_case_member(case_id,actor_id,NULL); END LOOP;
  IF download AND NOT EXISTS (SELECT 1 FROM app.hr_export_decisions WHERE export_id=target_export AND decision='approved') THEN
    RAISE EXCEPTION 'export has not been approved' USING ERRCODE='check_violation';
  END IF;
  IF download THEN PERFORM set_config('app.hr_write','1',true);
    INSERT INTO app.hr_export_access_log(export_id,accessed_by) VALUES(target_export,actor_id); END IF;
  RETURN NEXT selected;
END;
$$;
REVOKE ALL ON FUNCTION app.read_hr_export(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_export(uuid,uuid,boolean) TO pms_app;
