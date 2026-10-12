-- People / HR step 16c: lifecycle checklists, right-to-work checks and
-- qualification / professional-status evidence.

CREATE TABLE app.hr_lifecycle_checklists (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  engagement_id uuid NOT NULL REFERENCES app.hr_engagements(id),
  kind text NOT NULL CHECK (kind IN ('joiner','mover','leaver')),
  effective_on date NOT NULL CHECK (effective_on >= DATE '1900-01-01'),
  reason_category text,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_lifecycle_reason_shape CHECK (
    (kind<>'leaver' AND reason_category IS NULL)
    OR (kind='leaver' AND reason_category IN
      ('resignation','dismissal','redundancy','retirement','end_of_fixed_term','transfer','other'))),
  UNIQUE(engagement_id,kind,effective_on)
);

CREATE TABLE app.hr_lifecycle_items (
  id uuid PRIMARY KEY, checklist_id uuid NOT NULL REFERENCES app.hr_lifecycle_checklists(id),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 2 AND 200),
  owner_kind text NOT NULL CHECK (owner_kind IN ('hr','administrator','manager','worker','other_module')),
  required boolean NOT NULL, due_on date,
  created_by uuid NOT NULL REFERENCES app.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(checklist_id,code)
);

CREATE TABLE app.hr_lifecycle_item_events (
  id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES app.hr_lifecycle_items(id),
  action text NOT NULL CHECK (action IN ('completed','reopened')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_lifecycle_item_event_crypto CHECK (
    context='hr-lifecycle-item-event:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);

CREATE TABLE app.hr_lifecycle_checklist_events (
  id uuid PRIMARY KEY, checklist_id uuid NOT NULL REFERENCES app.hr_lifecycle_checklists(id),
  action text NOT NULL CHECK (action IN ('completed','reopened')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_lifecycle_event_crypto CHECK (
    context='hr-lifecycle-event:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);

CREATE TABLE app.hr_right_to_work_checks (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  engagement_id uuid NOT NULL REFERENCES app.hr_engagements(id),
  version integer NOT NULL CHECK (version>0),
  previous_check_id uuid REFERENCES app.hr_right_to_work_checks(id),
  guidance_version text NOT NULL CHECK (app.is_safe_text(guidance_version) AND length(guidance_version) BETWEEN 2 AND 200),
  check_route text NOT NULL CHECK (check_route IN ('manual','online','digital_provider')),
  checked_on date NOT NULL CHECK (checked_on >= DATE '1900-01-01'),
  permission_type text NOT NULL CHECK (permission_type IN
    ('british_or_irish','settled','pre_settled','time_limited','other')),
  result text NOT NULL CHECK (result IN ('passed','failed','follow_up_required')),
  expires_on date, follow_up_on date,
  evidence_file_id uuid NOT NULL REFERENCES app.hr_files(id),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  checked_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_rtw_dates CHECK (
    (expires_on IS NULL OR expires_on>=checked_on)
    AND (follow_up_on IS NULL OR follow_up_on>=checked_on)
    AND (permission_type<>'time_limited' OR expires_on IS NOT NULL)
    AND (follow_up_on IS NULL OR expires_on IS NULL OR follow_up_on<=expires_on)),
  CONSTRAINT hr_rtw_crypto CHECK (
    context='hr-rtw:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000),
  UNIQUE(engagement_id,version), UNIQUE(previous_check_id)
);
CREATE INDEX hr_rtw_person_current ON app.hr_right_to_work_checks(person_id,version DESC,id DESC);

CREATE TABLE app.hr_professional_records (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  kind text NOT NULL CHECK (kind IN ('qualification','professional_registration','practising_certificate')),
  title text NOT NULL CHECK (app.is_safe_text(title) AND length(title) BETWEEN 2 AND 200),
  issuer text NOT NULL CHECK (app.is_safe_text(issuer) AND length(issuer) BETWEEN 2 AND 200),
  valid_from date, valid_to date,
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_professional_dates CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to>=valid_from)),
  CONSTRAINT hr_professional_crypto CHECK (
    context='hr-professional:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_professional_person ON app.hr_professional_records(person_id,recorded_at DESC,id DESC);

CREATE TABLE app.hr_professional_check_events (
  id uuid PRIMARY KEY, record_id uuid NOT NULL REFERENCES app.hr_professional_records(id),
  status text NOT NULL CHECK (status IN ('current','expired','restricted','suspended','not_verified')),
  checked_on date NOT NULL CHECK (checked_on >= DATE '1900-01-01'),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_professional_check_crypto CHECK (
    context='hr-professional-check:'||id::text AND key_version>0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_professional_check_record ON app.hr_professional_check_events(record_id,checked_on DESC,recorded_at DESC,id DESC);

REVOKE ALL ON app.hr_lifecycle_checklists,app.hr_lifecycle_items,
  app.hr_lifecycle_item_events,app.hr_lifecycle_checklist_events,
  app.hr_right_to_work_checks,app.hr_professional_records,
  app.hr_professional_check_events FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['hr_lifecycle_checklists','hr_lifecycle_items',
    'hr_lifecycle_item_events','hr_lifecycle_checklist_events','hr_right_to_work_checks',
    'hr_professional_records','hr_professional_check_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_hr_insert()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_hr_history_change()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_hr_truncate()',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.create_hr_lifecycle_checklist(target_id uuid,target_person uuid,target_engagement uuid,
  selected_kind text,selected_effective date,selected_reason text,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE engagement app.hr_engagements%ROWTYPE;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO engagement FROM app.hr_engagements WHERE id=target_engagement AND person_id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_effective<engagement.started_on OR (engagement.ended_on IS NOT NULL AND selected_effective>engagement.ended_on) THEN
    RAISE EXCEPTION 'the checklist date is outside the engagement' USING ERRCODE='check_violation';
  END IF;
  IF selected_kind='joiner' AND selected_effective<>engagement.started_on THEN
    RAISE EXCEPTION 'a joiner checklist uses the engagement start date' USING ERRCODE='check_violation';
  END IF;
  IF selected_kind='leaver' AND engagement.ended_on IS DISTINCT FROM selected_effective THEN
    RAISE EXCEPTION 'a leaver checklist requires the recorded final day' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_lifecycle_checklists(id,person_id,engagement_id,kind,effective_on,reason_category,created_by)
    VALUES(target_id,target_person,target_engagement,selected_kind,selected_effective,selected_reason,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_lifecycle_checklist(uuid,uuid,uuid,text,date,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_lifecycle_checklist(uuid,uuid,uuid,text,date,text,uuid) TO pms_app;

CREATE FUNCTION app.add_hr_lifecycle_item(target_id uuid,target_checklist uuid,selected_code text,
  selected_title text,selected_owner text,selected_required boolean,selected_due date,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_lifecycle_checklists WHERE id=target_checklist FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF EXISTS(SELECT 1 FROM app.hr_lifecycle_checklist_events completed_event
      WHERE completed_event.checklist_id=target_checklist AND completed_event.action='completed'
      AND NOT EXISTS(SELECT 1 FROM app.hr_lifecycle_checklist_events later
        WHERE later.checklist_id=target_checklist AND later.action='reopened'
          AND (later.recorded_at,later.id)>(completed_event.recorded_at,completed_event.id))) THEN
    RAISE EXCEPTION 'a completed checklist must be reopened before items are added' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_lifecycle_items(id,checklist_id,code,title,owner_kind,required,due_on,created_by)
    VALUES(target_id,target_checklist,selected_code,selected_title,selected_owner,selected_required,selected_due,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.add_hr_lifecycle_item(uuid,uuid,text,text,text,boolean,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_hr_lifecycle_item(uuid,uuid,text,text,text,boolean,date,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_lifecycle_item_event(target_id uuid,target_item uuid,selected_action text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_checklist uuid; current_action text;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT checklist_id INTO target_checklist FROM app.hr_lifecycle_items WHERE id=target_item FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT action INTO current_action FROM app.hr_lifecycle_item_events WHERE item_id=target_item
    ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF (selected_action='completed' AND current_action='completed')
      OR (selected_action='reopened' AND current_action IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'the lifecycle item is already in that state' USING ERRCODE='check_violation';
  END IF;
  IF EXISTS(SELECT 1 FROM app.hr_lifecycle_checklist_events completed_event
      WHERE completed_event.checklist_id=target_checklist AND completed_event.action='completed'
      AND NOT EXISTS(SELECT 1 FROM app.hr_lifecycle_checklist_events later
        WHERE later.checklist_id=target_checklist AND later.action='reopened'
          AND (later.recorded_at,later.id)>(completed_event.recorded_at,completed_event.id))) THEN
    RAISE EXCEPTION 'the checklist is completed' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_lifecycle_item_events(id,item_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_item,selected_action,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_lifecycle_item_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_lifecycle_item_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.hr_leaver_blockers(target_checklist uuid)
RETURNS TABLE(kind text,resource_id uuid,status text)
  LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH subject AS (
    SELECT person.account_id FROM app.hr_lifecycle_checklists checklist
    JOIN app.hr_people person ON person.id=checklist.person_id
    WHERE checklist.id=target_checklist AND checklist.kind='leaver'
  )
  SELECT 'account',account.id,account.status FROM subject JOIN app.accounts account ON account.id=subject.account_id
    WHERE account.status<>'disabled'
  UNION ALL SELECT 'protected_role',role.id,role.role FROM subject JOIN app.account_roles role
    ON role.account_id=subject.account_id WHERE role.revoked_at IS NULL AND role.role IN ('administrator','compliance')
  UNION ALL SELECT 'client_responsibility',client.id,client.status FROM subject JOIN app.clients client
    ON client.responsible_id=subject.account_id WHERE client.status='active'
  UNION ALL SELECT 'matter_supervision',team.matter_id,matter.status FROM subject JOIN app.matter_team team
    ON team.account_id=subject.account_id AND team.role='supervising_partner' AND team.removed_at IS NULL
    JOIN app.matters matter ON matter.id=team.matter_id WHERE matter.status<>'closed'
  UNION ALL SELECT 'task_assignment',task.id,task.status FROM subject JOIN app.tasks task
    ON task.assigned_to=subject.account_id WHERE task.status='open'
  UNION ALL SELECT 'aml_appointment',appointment.id,appointment.kind FROM subject JOIN app.aml_officer_appointments appointment
    ON appointment.account_id=subject.account_id WHERE appointment.ended_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.hr_leaver_blockers(uuid) FROM PUBLIC;

CREATE FUNCTION app.record_hr_lifecycle_checklist_event(target_id uuid,target_checklist uuid,selected_action text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE checklist app.hr_lifecycle_checklists%ROWTYPE; current_action text;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  SELECT * INTO checklist FROM app.hr_lifecycle_checklists WHERE id=target_checklist FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  SELECT action INTO current_action FROM app.hr_lifecycle_checklist_events WHERE checklist_id=target_checklist
    ORDER BY recorded_at DESC,id DESC LIMIT 1;
  IF (selected_action='completed' AND current_action='completed')
      OR (selected_action='reopened' AND current_action IS DISTINCT FROM 'completed') THEN
    RAISE EXCEPTION 'the lifecycle checklist is already in that state' USING ERRCODE='check_violation';
  END IF;
  IF selected_action='completed' THEN
    IF NOT EXISTS(SELECT 1 FROM app.hr_lifecycle_items WHERE checklist_id=target_checklist AND required) THEN
      RAISE EXCEPTION 'a checklist needs at least one required item' USING ERRCODE='check_violation';
    END IF;
    IF EXISTS(SELECT 1 FROM app.hr_lifecycle_items item WHERE item.checklist_id=target_checklist AND item.required
        AND coalesce((SELECT event.action FROM app.hr_lifecycle_item_events event WHERE event.item_id=item.id
          ORDER BY event.recorded_at DESC,event.id DESC LIMIT 1),'reopened')<>'completed') THEN
      RAISE EXCEPTION 'required lifecycle items are incomplete' USING ERRCODE='check_violation';
    END IF;
    IF checklist.kind IN ('joiner','mover') AND NOT EXISTS(
      SELECT 1 FROM app.hr_right_to_work_checks check_record
      WHERE check_record.engagement_id=checklist.engagement_id AND check_record.result='passed'
        AND (coalesce(check_record.follow_up_on,check_record.expires_on) IS NULL
          OR coalesce(check_record.follow_up_on,check_record.expires_on) >=
            (clock_timestamp() AT TIME ZONE 'Europe/London')::date)
        AND NOT EXISTS(SELECT 1 FROM app.hr_right_to_work_checks later
          WHERE later.engagement_id=checklist.engagement_id AND later.version>check_record.version)
    ) THEN RAISE EXCEPTION 'a current passing right-to-work check is required' USING ERRCODE='check_violation'; END IF;
    IF checklist.kind='leaver' AND EXISTS(SELECT 1 FROM app.hr_leaver_blockers(target_checklist)) THEN
      RAISE EXCEPTION 'the leaver still has unresolved ownership or access blockers' USING ERRCODE='check_violation';
    END IF;
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_lifecycle_checklist_events(id,checklist_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_checklist,selected_action,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_lifecycle_checklist_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_lifecycle_checklist_event(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_right_to_work_check(target_id uuid,target_person uuid,target_engagement uuid,
  selected_guidance text,selected_route text,selected_checked date,selected_permission text,
  selected_result text,selected_expiry date,selected_follow_up date,target_file uuid,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE next_version integer; prior_id uuid; prior_date date;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_rtw:'||target_engagement::text,0));
  PERFORM 1 FROM app.hr_engagements WHERE id=target_engagement AND person_id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.hr_files WHERE id=target_file AND person_id=target_person AND category='identity' FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_checked>(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'right-to-work checks cannot be future dated' USING ERRCODE='check_violation';
  END IF;
  SELECT id,checked_on,version+1 INTO prior_id,prior_date,next_version FROM app.hr_right_to_work_checks
    WHERE engagement_id=target_engagement ORDER BY version DESC LIMIT 1;
  next_version:=coalesce(next_version,1);
  IF prior_date IS NOT NULL AND selected_checked<prior_date THEN
    RAISE EXCEPTION 'right-to-work checks cannot be backdated over later evidence' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_right_to_work_checks(id,person_id,engagement_id,version,previous_check_id,
    guidance_version,check_route,checked_on,permission_type,result,expires_on,follow_up_on,evidence_file_id,
    context,key_version,nonce,ciphertext,auth_tag,checked_by)
    VALUES(target_id,target_person,target_engagement,next_version,prior_id,selected_guidance,selected_route,
      selected_checked,selected_permission,selected_result,selected_expiry,selected_follow_up,target_file,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
  RETURN next_version;
END $$;
REVOKE ALL ON FUNCTION app.record_hr_right_to_work_check(uuid,uuid,uuid,text,text,date,text,text,date,date,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_right_to_work_check(uuid,uuid,uuid,text,text,date,text,text,date,date,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_professional_record(target_id uuid,target_person uuid,selected_kind text,
  selected_title text,selected_issuer text,selected_from date,selected_to date,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_professional_records(id,person_id,kind,title,issuer,valid_from,valid_to,
    context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_person,selected_kind,selected_title,selected_issuer,selected_from,selected_to,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_professional_record(uuid,uuid,text,text,text,date,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_professional_record(uuid,uuid,text,text,text,date,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_professional_check(target_id uuid,target_record uuid,selected_status text,
  selected_checked date,selected_context text,selected_key smallint,selected_nonce bytea,
  selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE prior_date date;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_professional_records WHERE id=target_record FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_checked>(clock_timestamp() AT TIME ZONE 'Europe/London')::date THEN
    RAISE EXCEPTION 'professional checks cannot be future dated' USING ERRCODE='check_violation';
  END IF;
  SELECT checked_on INTO prior_date FROM app.hr_professional_check_events WHERE record_id=target_record
    ORDER BY checked_on DESC,recorded_at DESC,id DESC LIMIT 1;
  IF prior_date IS NOT NULL AND selected_checked<prior_date THEN
    RAISE EXCEPTION 'professional checks cannot be backdated over later evidence' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_professional_check_events(id,record_id,status,checked_on,context,key_version,
    nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_record,selected_status,selected_checked,selected_context,selected_key,
      selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_professional_check(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_professional_check(uuid,uuid,text,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

-- Safe lifecycle and vetting projections. Sensitive ciphertext is returned only
-- by the separate HR/self detail functions below.
CREATE FUNCTION app.read_hr_lifecycle(target_person uuid,actor_id uuid)
RETURNS TABLE(checklist_id uuid,engagement_id uuid,kind text,effective_on date,reason_category text,
  checklist_state text,item_id uuid,code text,title text,owner_kind text,required boolean,due_on date,item_state text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT checklist.id,checklist.engagement_id,checklist.kind,checklist.effective_on,
    checklist.reason_category,coalesce((SELECT event.action FROM app.hr_lifecycle_checklist_events event
      WHERE event.checklist_id=checklist.id ORDER BY event.recorded_at DESC,event.id DESC LIMIT 1),'open'),
    item.id,item.code,item.title,item.owner_kind,item.required,item.due_on,
    coalesce((SELECT event.action FROM app.hr_lifecycle_item_events event WHERE event.item_id=item.id
      ORDER BY event.recorded_at DESC,event.id DESC LIMIT 1),'open')
  FROM app.hr_lifecycle_checklists checklist LEFT JOIN app.hr_lifecycle_items item ON item.checklist_id=checklist.id
  WHERE checklist.person_id=target_person ORDER BY checklist.effective_on DESC,checklist.id,item.created_at,item.id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_lifecycle(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_lifecycle(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_leaver_blockers(target_checklist uuid,actor_id uuid)
RETURNS TABLE(kind text,resource_id uuid,status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_lifecycle_checklists checklist
    WHERE checklist.id=target_checklist AND checklist.kind='leaver';
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  RETURN QUERY SELECT * FROM app.hr_leaver_blockers(target_checklist);
END $$;
REVOKE ALL ON FUNCTION app.read_hr_leaver_blockers(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_leaver_blockers(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_right_to_work_status(target_person uuid,actor_id uuid)
RETURNS TABLE(id uuid,engagement_id uuid,version integer,result text,permission_type text,
  checked_on date,expires_on date,follow_up_on date,overdue boolean,action_required boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT check_record.id,check_record.engagement_id,check_record.version,check_record.result,
    check_record.permission_type,check_record.checked_on,check_record.expires_on,check_record.follow_up_on,
    coalesce(coalesce(check_record.follow_up_on,check_record.expires_on) <
      (clock_timestamp() AT TIME ZONE 'Europe/London')::date,false),
    check_record.result<>'passed' OR coalesce(coalesce(check_record.follow_up_on,check_record.expires_on) <
      (clock_timestamp() AT TIME ZONE 'Europe/London')::date,false)
  FROM app.hr_right_to_work_checks check_record WHERE check_record.person_id=target_person
    AND NOT EXISTS(SELECT 1 FROM app.hr_right_to_work_checks later
      WHERE later.engagement_id=check_record.engagement_id AND later.version>check_record.version)
  ORDER BY check_record.recorded_at DESC,check_record.id DESC;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_right_to_work_status(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_right_to_work_status(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_right_to_work_checks(target_person uuid,actor_id uuid)
RETURNS SETOF app.hr_right_to_work_checks
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT * FROM app.hr_right_to_work_checks WHERE person_id=target_person ORDER BY version,id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_right_to_work_checks(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_right_to_work_checks(uuid,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_vetting_due(actor_id uuid)
RETURNS TABLE(person_id uuid,account_id uuid,display_name text,check_id uuid,engagement_id uuid,
  result text,expires_on date,follow_up_on date,overdue boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT check_record.person_id,person.account_id,account.display_name,check_record.id,
    check_record.engagement_id,check_record.result,check_record.expires_on,check_record.follow_up_on,
    coalesce(coalesce(check_record.follow_up_on,check_record.expires_on) <
      (clock_timestamp() AT TIME ZONE 'Europe/London')::date,false)
  FROM app.hr_right_to_work_checks check_record JOIN app.hr_people person ON person.id=check_record.person_id
  JOIN app.accounts account ON account.id=person.account_id
  WHERE NOT EXISTS(SELECT 1 FROM app.hr_right_to_work_checks later
      WHERE later.engagement_id=check_record.engagement_id AND later.version>check_record.version)
    AND (check_record.result<>'passed' OR coalesce(check_record.follow_up_on,check_record.expires_on) <=
      (clock_timestamp() AT TIME ZONE 'Europe/London')::date+INTERVAL '30 days')
  ORDER BY coalesce(check_record.follow_up_on,check_record.expires_on) NULLS FIRST,
    check_record.recorded_at,check_record.id;
END $$;
REVOKE ALL ON FUNCTION app.list_hr_vetting_due(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_vetting_due(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_professional_records(target_person uuid,actor_id uuid,manager_projection boolean)
RETURNS TABLE(id uuid,person_id uuid,kind text,title text,issuer text,valid_from date,valid_to date,
  context text,key_version smallint,nonce bytea,ciphertext bytea,auth_tag bytea,recorded_by uuid,
  recorded_at timestamptz,status text,checked_on date,check_context text,check_key_version smallint,
  check_nonce bytea,check_ciphertext bytea,check_auth_tag bytea,checked_by uuid,check_recorded_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF manager_projection AND allowed<>'manager' THEN RAISE EXCEPTION 'manager projection required' USING ERRCODE='insufficient_privilege'; END IF;
  IF NOT manager_projection AND allowed='manager' THEN RAISE EXCEPTION 'professional detail access denied' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN QUERY SELECT record.id,record.person_id,record.kind,record.title,record.issuer,record.valid_from,record.valid_to,
    CASE WHEN allowed='manager' THEN NULL ELSE record.context END,
    CASE WHEN allowed='manager' THEN NULL ELSE record.key_version END,
    CASE WHEN allowed='manager' THEN NULL ELSE record.nonce END,
    CASE WHEN allowed='manager' THEN NULL ELSE record.ciphertext END,
    CASE WHEN allowed='manager' THEN NULL ELSE record.auth_tag END,record.recorded_by,record.recorded_at,
    check_event.status,check_event.checked_on,
    CASE WHEN allowed='manager' THEN NULL ELSE check_event.context END,
    CASE WHEN allowed='manager' THEN NULL ELSE check_event.key_version END,
    CASE WHEN allowed='manager' THEN NULL ELSE check_event.nonce END,
    CASE WHEN allowed='manager' THEN NULL ELSE check_event.ciphertext END,
    CASE WHEN allowed='manager' THEN NULL ELSE check_event.auth_tag END,
    check_event.recorded_by,check_event.recorded_at
  FROM app.hr_professional_records record LEFT JOIN LATERAL (
    SELECT event.* FROM app.hr_professional_check_events event WHERE event.record_id=record.id
    ORDER BY event.checked_on DESC,event.recorded_at DESC,event.id DESC LIMIT 1
  ) check_event ON true WHERE record.person_id=target_person ORDER BY record.recorded_at DESC,record.id DESC;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_professional_records(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_professional_records(uuid,uuid,boolean) TO pms_app;
