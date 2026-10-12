-- People / HR step 16d: development, required learning, objectives and appraisals.

CREATE TABLE app.hr_development_cycles (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 2 AND 200),
  period_start date NOT NULL CHECK (period_start>=DATE '1900-01-01'),
  period_end date NOT NULL CHECK (period_end>=period_start),
  created_by uuid NOT NULL REFERENCES app.accounts(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.hr_development_events (
  id uuid PRIMARY KEY, cycle_id uuid NOT NULL REFERENCES app.hr_development_cycles(id),
  kind text NOT NULL CHECK (kind IN ('reflection','need','plan','activity','evaluation','review','requirement','status')),
  state text CHECK (state IN ('planned','active','completed','closed')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_development_event_shape CHECK ((kind='status')=(state IS NOT NULL)),
  CONSTRAINT hr_development_event_crypto CHECK (context='hr-development-event:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_development_person ON app.hr_development_cycles(person_id,period_end DESC,id DESC);
CREATE INDEX hr_development_events_cycle ON app.hr_development_events(cycle_id,recorded_at,id);

CREATE TABLE app.hr_learning_assignments (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 2 AND 200),
  provider text CHECK (provider IS NULL OR (app.is_safe_text(provider) AND length(provider) BETWEEN 2 AND 200)),
  due_on date NOT NULL CHECK (due_on>=DATE '1900-01-01'),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  assigned_by uuid NOT NULL REFERENCES app.accounts(id), assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_learning_assignment_crypto CHECK (context='hr-learning-assignment:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);

CREATE TABLE app.hr_learning_events (
  id uuid PRIMARY KEY, assignment_id uuid NOT NULL REFERENCES app.hr_learning_assignments(id),
  action text NOT NULL CHECK (action IN ('completed','reopened')),
  completed_on date,
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_learning_event_shape CHECK ((action='completed')=(completed_on IS NOT NULL)
    AND (completed_on IS NULL OR completed_on>=DATE '1900-01-01')),
  CONSTRAINT hr_learning_event_crypto CHECK (context='hr-learning-event:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_learning_person ON app.hr_learning_assignments(person_id,due_on,id);
CREATE INDEX hr_learning_events_assignment ON app.hr_learning_events(assignment_id,recorded_at,id);

CREATE TABLE app.hr_review_records (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  kind text NOT NULL CHECK (kind IN ('objective','appraisal')),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 2 AND 200),
  period_start date, period_end date, target_on date,
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_review_record_shape CHECK (
    (kind='objective' AND period_start IS NULL AND period_end IS NULL AND target_on>=DATE '1900-01-01')
    OR (kind='appraisal' AND period_start>=DATE '1900-01-01' AND period_end>=period_start AND target_on IS NULL)),
  CONSTRAINT hr_review_record_crypto CHECK (context='hr-review-record:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);

CREATE TABLE app.hr_review_worker_events (
  id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES app.hr_review_records(id),
  action text NOT NULL CHECK (action IN ('acknowledged','response','disagreement')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_review_worker_event_crypto CHECK (context='hr-review-worker-event:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16 AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE UNIQUE INDEX hr_review_one_acknowledgement ON app.hr_review_worker_events(review_id) WHERE action='acknowledged';
CREATE INDEX hr_review_person ON app.hr_review_records(person_id,recorded_at DESC,id DESC);
CREATE INDEX hr_review_worker_events_review ON app.hr_review_worker_events(review_id,recorded_at,id);

REVOKE ALL ON app.hr_development_cycles,app.hr_development_events,app.hr_learning_assignments,
  app.hr_learning_events,app.hr_review_records,app.hr_review_worker_events FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['hr_development_cycles','hr_development_events','hr_learning_assignments',
    'hr_learning_events','hr_review_records','hr_review_worker_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_hr_insert()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_hr_history_change()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_hr_truncate()',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.create_hr_development_cycle(target_id uuid,target_person uuid,selected_title text,
  selected_start date,selected_end date,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_development_cycles(id,person_id,title,period_start,period_end,created_by)
    VALUES(target_id,target_person,selected_title,selected_start,selected_end,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_development_cycle(uuid,uuid,text,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_development_cycle(uuid,uuid,text,date,date,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_development_event(target_id uuid,target_cycle uuid,selected_kind text,
  selected_state text,selected_context text,selected_key smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_person uuid; allowed text;
BEGIN
  SELECT person_id INTO target_person FROM app.hr_development_cycles WHERE id=target_cycle FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF selected_kind IN ('reflection','need','plan','activity','evaluation') AND allowed<>'self' THEN
    RAISE EXCEPTION 'the worker owns development narrative' USING ERRCODE='insufficient_privilege';
  END IF;
  IF selected_kind IN ('review','requirement','status') AND allowed NOT IN ('manager','hr') THEN
    RAISE EXCEPTION 'manager or HR review required' USING ERRCODE='insufficient_privilege';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_development_events(id,cycle_id,kind,state,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_cycle,selected_kind,selected_state,selected_context,selected_key,selected_nonce,
      selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_development_event(uuid,uuid,text,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_development_event(uuid,uuid,text,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.assign_hr_learning(target_id uuid,target_person uuid,selected_title text,selected_provider text,
  selected_due date,selected_context text,selected_key smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_learning_assignments(id,person_id,title,provider,due_on,context,key_version,nonce,
    ciphertext,auth_tag,assigned_by) VALUES(target_id,target_person,selected_title,selected_provider,selected_due,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.assign_hr_learning(uuid,uuid,text,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assign_hr_learning(uuid,uuid,text,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_learning_event(target_id uuid,target_assignment uuid,selected_action text,
  selected_completed date,selected_context text,selected_key smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_person uuid; allowed text; current_action text;
BEGIN
  SELECT person_id INTO target_person FROM app.hr_learning_assignments WHERE id=target_assignment FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,target_person,false);
  IF allowed NOT IN ('self','hr') THEN RAISE EXCEPTION 'worker or HR access required' USING ERRCODE='insufficient_privilege'; END IF;
  IF selected_completed>(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'learning completion cannot be future dated' USING ERRCODE='check_violation';
  END IF;
  SELECT action INTO current_action FROM app.hr_learning_events WHERE assignment_id=target_assignment
    ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF (selected_action='completed' AND current_action='completed')
      OR (selected_action='reopened' AND current_action IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'the learning assignment is already in that state' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_learning_events(id,assignment_id,action,completed_on,context,key_version,nonce,
    ciphertext,auth_tag,recorded_by) VALUES(target_id,target_assignment,selected_action,selected_completed,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_learning_event(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_learning_event(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_review_record(target_id uuid,target_person uuid,selected_kind text,
  selected_title text,selected_start date,selected_end date,selected_target date,selected_context text,
  selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF allowed NOT IN ('manager','hr') THEN RAISE EXCEPTION 'manager or HR review required' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_review_records(id,person_id,kind,title,period_start,period_end,target_on,context,
    key_version,nonce,ciphertext,auth_tag,recorded_by) VALUES(target_id,target_person,selected_kind,
      selected_title,selected_start,selected_end,selected_target,selected_context,selected_key,
      selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_review_record(uuid,uuid,text,text,date,date,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_review_record(uuid,uuid,text,text,date,date,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_review_worker_event(target_id uuid,target_review uuid,selected_action text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_person uuid; allowed text;
BEGIN
  SELECT person_id INTO target_person FROM app.hr_review_records WHERE id=target_review FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,target_person,false);
  IF allowed<>'self' THEN RAISE EXCEPTION 'only the worker can acknowledge or respond' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_review_worker_events(id,review_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_review,selected_action,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_review_worker_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_review_worker_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_development(target_person uuid,actor_id uuid)
RETURNS TABLE(cycle_id uuid,title text,period_start date,period_end date,created_by uuid,created_at timestamptz,
  event_id uuid,kind text,state text,context text,key_version smallint,nonce bytea,ciphertext bytea,auth_tag bytea,
  recorded_by uuid,recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT cycle.id,cycle.title,cycle.period_start,cycle.period_end,cycle.created_by,cycle.created_at,
    event.id,event.kind,event.state,event.context,event.key_version,event.nonce,event.ciphertext,event.auth_tag,
    event.recorded_by,event.recorded_at FROM app.hr_development_cycles cycle
    LEFT JOIN app.hr_development_events event ON event.cycle_id=cycle.id WHERE cycle.person_id=target_person
    ORDER BY cycle.period_end DESC,cycle.id,event.recorded_at,event.id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_development(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_development(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_learning(target_person uuid,actor_id uuid)
RETURNS TABLE(assignment_id uuid,title text,provider text,due_on date,assignment_context text,
  assignment_key_version smallint,assignment_nonce bytea,assignment_ciphertext bytea,assignment_auth_tag bytea,
  assigned_by uuid,assigned_at timestamptz,event_id uuid,action text,completed_on date,event_context text,
  event_key_version smallint,event_nonce bytea,event_ciphertext bytea,event_auth_tag bytea,
  recorded_by uuid,recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT assignment.id,assignment.title,assignment.provider,assignment.due_on,assignment.context,
    assignment.key_version,assignment.nonce,assignment.ciphertext,assignment.auth_tag,assignment.assigned_by,
    assignment.assigned_at,event.id,event.action,event.completed_on,event.context,event.key_version,event.nonce,
    event.ciphertext,event.auth_tag,event.recorded_by,event.recorded_at FROM app.hr_learning_assignments assignment
    LEFT JOIN app.hr_learning_events event ON event.assignment_id=assignment.id WHERE assignment.person_id=target_person
    ORDER BY assignment.due_on,assignment.id,event.recorded_at,event.id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_learning(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_learning(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_reviews(target_person uuid,actor_id uuid)
RETURNS TABLE(review_id uuid,kind text,title text,period_start date,period_end date,target_on date,
  review_context text,review_key_version smallint,review_nonce bytea,review_ciphertext bytea,review_auth_tag bytea,
  review_recorded_by uuid,review_recorded_at timestamptz,event_id uuid,action text,event_context text,
  event_key_version smallint,event_nonce bytea,event_ciphertext bytea,event_auth_tag bytea,
  event_recorded_by uuid,event_recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT review.id,review.kind,review.title,review.period_start,review.period_end,review.target_on,
    review.context,review.key_version,review.nonce,review.ciphertext,review.auth_tag,review.recorded_by,review.recorded_at,
    event.id,event.action,event.context,event.key_version,event.nonce,event.ciphertext,event.auth_tag,
    event.recorded_by,event.recorded_at FROM app.hr_review_records review LEFT JOIN app.hr_review_worker_events event
      ON event.review_id=review.id WHERE review.person_id=target_person
    ORDER BY review.recorded_at DESC,review.id,event.recorded_at,event.id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_reviews(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_reviews(uuid,uuid) TO pms_app;

-- Compliance owns AML training; this projection exposes no provider, evidence or control text.
CREATE FUNCTION app.read_aml_training_status_for_hr(target_person uuid,actor_id uuid)
RETURNS TABLE(material_id uuid,title text,version integer,completed_on date,due_on date,status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_account uuid;
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  SELECT account_id INTO target_account FROM app.hr_people WHERE id=target_person;
  RETURN QUERY SELECT material.id,material.title,material.version,completion.completed_on,material.review_due_on,
    CASE WHEN material.review_due_on<(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN 'expired'
      WHEN completion.id IS NOT NULL THEN 'completed'
      ELSE 'due' END
  FROM app.aml_control_versions material JOIN app.aml_control_approvals approval
    ON approval.control_version_id=material.id
  LEFT JOIN app.aml_training_completions completion
    ON completion.training_material_id=material.id AND completion.account_id=target_account
  WHERE material.kind='training_material'
    AND material.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/London')::date
  ORDER BY material.version DESC,material.id DESC;
END $$;
REVOKE ALL ON FUNCTION app.read_aml_training_status_for_hr(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_aml_training_status_for_hr(uuid,uuid) TO pms_app;
