-- People / HR step 16b: exact leave evidence, reason-free sickness
-- administration, encrypted health records and operational adjustments.

CREATE TABLE app.hr_leave_policies (
  id uuid PRIMARY KEY DEFAULT uuidv7(), version integer NOT NULL UNIQUE,
  effective_from date NOT NULL UNIQUE,
  leave_year_month smallint NOT NULL CHECK (leave_year_month BETWEEN 1 AND 12),
  leave_year_day smallint NOT NULL CHECK (leave_year_day BETWEEN 1 AND 28),
  standard_entitlement_minutes integer NOT NULL CHECK (standard_entitlement_minutes > 0),
  carry_over_limit_minutes integer NOT NULL CHECK (carry_over_limit_minutes >= 0),
  booking_notice_days smallint NOT NULL CHECK (booking_notice_days BETWEEN 0 AND 366),
  annual_approval_route text NOT NULL CHECK (annual_approval_route IN ('manager_or_hr','hr_only')),
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.hr_leave_requests (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  policy_id uuid NOT NULL REFERENCES app.hr_leave_policies(id),
  kind text NOT NULL CHECK (kind IN ('annual','family','compassionate','unpaid','other')),
  starts_on date NOT NULL, ends_on date NOT NULL, leave_year_start date NOT NULL,
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app.accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_leave_request_dates CHECK (
    starts_on >= DATE '1900-01-01' AND ends_on >= starts_on AND ends_on <= starts_on + 366
    AND leave_year_start <= starts_on AND starts_on < leave_year_start + INTERVAL '1 year'),
  CONSTRAINT hr_leave_request_crypto CHECK (
    context = 'hr-leave-request:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);
CREATE INDEX hr_leave_requests_person ON app.hr_leave_requests(person_id, submitted_at DESC, id DESC);

CREATE TABLE app.hr_leave_request_events (
  id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES app.hr_leave_requests(id),
  action text NOT NULL CHECK (action IN ('approved','refused','cancelled')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_leave_event_crypto CHECK (
    context = 'hr-leave-event:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);
CREATE UNIQUE INDEX hr_leave_one_decision ON app.hr_leave_request_events(request_id)
  WHERE action IN ('approved','refused');
CREATE UNIQUE INDEX hr_leave_one_cancellation ON app.hr_leave_request_events(request_id)
  WHERE action = 'cancelled';

CREATE TABLE app.hr_leave_request_days (
  id uuid PRIMARY KEY DEFAULT uuidv7(), request_id uuid NOT NULL REFERENCES app.hr_leave_requests(id),
  person_id uuid NOT NULL REFERENCES app.hr_people(id), leave_on date NOT NULL,
  minutes smallint NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id, leave_on)
);
CREATE INDEX hr_leave_days_person ON app.hr_leave_request_days(person_id, leave_on);

CREATE TABLE app.hr_leave_entitlement_entries (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  leave_year_start date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening_grant','accrual','adjustment','carry_over','consumption','cancellation_return','leaving_adjustment')),
  minutes integer NOT NULL CHECK (minutes <> 0),
  leave_request_id uuid REFERENCES app.hr_leave_requests(id),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_leave_entitlement_link CHECK (
    (kind IN ('consumption','cancellation_return') AND leave_request_id IS NOT NULL)
    OR (kind NOT IN ('consumption','cancellation_return') AND leave_request_id IS NULL)),
  CONSTRAINT hr_leave_entitlement_sign CHECK (
    (kind IN ('opening_grant','accrual','carry_over','cancellation_return') AND minutes > 0)
    OR (kind = 'consumption' AND minutes < 0)
    OR kind IN ('adjustment','leaving_adjustment')),
  CONSTRAINT hr_leave_entitlement_crypto CHECK (
    context = 'hr-leave-entitlement:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);
CREATE UNIQUE INDEX hr_leave_request_consumption ON app.hr_leave_entitlement_entries(leave_request_id,kind)
  WHERE leave_request_id IS NOT NULL;
CREATE INDEX hr_leave_entitlement_person ON app.hr_leave_entitlement_entries(person_id,leave_year_start,recorded_at,id);

CREATE TABLE app.hr_holiday_pay_records (
  id uuid PRIMARY KEY DEFAULT uuidv7(), person_id uuid NOT NULL REFERENCES app.hr_people(id),
  leave_request_id uuid NOT NULL REFERENCES app.hr_leave_requests(id),
  period_starts_on date NOT NULL, period_ends_on date NOT NULL,
  amount_pence bigint NOT NULL CHECK (amount_pence >= 0),
  basis text NOT NULL CHECK (basis IN ('normal','basic','rolled_up','other')),
  included_elements jsonb NOT NULL,
  retention_until date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_holiday_pay_dates CHECK (period_ends_on >= period_starts_on),
  CONSTRAINT hr_holiday_pay_elements CHECK (
    jsonb_typeof(included_elements)='array' AND jsonb_array_length(included_elements) BETWEEN 1 AND 20)
);
CREATE INDEX hr_holiday_pay_person ON app.hr_holiday_pay_records(person_id,period_starts_on DESC,id DESC);

CREATE TABLE app.hr_sickness_absences (
  id uuid PRIMARY KEY DEFAULT uuidv7(), person_id uuid NOT NULL REFERENCES app.hr_people(id),
  started_on date NOT NULL, ended_on date,
  notified_at timestamptz NOT NULL,
  fitness_status text NOT NULL CHECK (fitness_status IN ('fit','not_fit','may_be_fit','not_assessed')),
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_sickness_dates CHECK (started_on >= DATE '1900-01-01' AND (ended_on IS NULL OR ended_on >= started_on))
);
CREATE INDEX hr_sickness_person ON app.hr_sickness_absences(person_id,started_on DESC,id DESC);

CREATE TABLE app.hr_health_records (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  kind text NOT NULL CHECK (kind IN ('sickness_detail','fit_note','occupational_health','adjustment_ground')),
  valid_from date, valid_to date,
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_health_dates CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to >= valid_from)),
  CONSTRAINT hr_health_crypto CHECK (
    context = 'hr-health:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_health_person ON app.hr_health_records(person_id,recorded_at DESC,id DESC);

CREATE TABLE app.hr_adjustment_requests (
  id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES app.hr_people(id),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app.accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_adjustment_request_crypto CHECK (
    context = 'hr-adjustment-request:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 30000)
);
CREATE INDEX hr_adjustment_requests_person ON app.hr_adjustment_requests(person_id,submitted_at DESC,id DESC);

CREATE TABLE app.hr_adjustment_decisions (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES app.hr_adjustment_requests(id),
  outcome text NOT NULL CHECK (outcome IN ('agreed','refused')),
  private_context text NOT NULL, private_key_version smallint NOT NULL,
  private_nonce bytea NOT NULL, private_ciphertext bytea NOT NULL, private_auth_tag bytea NOT NULL,
  operational_context text, operational_key_version smallint, operational_nonce bytea,
  operational_ciphertext bytea, operational_auth_tag bytea,
  effective_on date, review_on date,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_adjustment_private_crypto CHECK (
    private_context = 'hr-adjustment-private:' || id::text AND private_key_version > 0
    AND octet_length(private_nonce)=12 AND octet_length(private_auth_tag)=16
    AND octet_length(private_ciphertext) BETWEEN 2 AND 30000),
  CONSTRAINT hr_adjustment_operational_shape CHECK (
    (outcome='refused' AND operational_context IS NULL AND operational_key_version IS NULL
      AND operational_nonce IS NULL AND operational_ciphertext IS NULL AND operational_auth_tag IS NULL
      AND effective_on IS NULL AND review_on IS NULL)
    OR (outcome='agreed' AND operational_context='hr-adjustment-operational:' || id::text
      AND operational_key_version > 0 AND octet_length(operational_nonce)=12
      AND octet_length(operational_auth_tag)=16 AND octet_length(operational_ciphertext) BETWEEN 2 AND 30000
      AND effective_on IS NOT NULL AND (review_on IS NULL OR review_on >= effective_on)))
);

CREATE TABLE app.hr_adjustment_progress_events (
  id uuid PRIMARY KEY, decision_id uuid NOT NULL REFERENCES app.hr_adjustment_decisions(id),
  action text NOT NULL CHECK (action IN ('implemented','reviewed','closed')),
  context text NOT NULL, key_version smallint NOT NULL, nonce bytea NOT NULL,
  ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  recorded_by uuid NOT NULL REFERENCES app.accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hr_adjustment_progress_crypto CHECK (
    context = 'hr-adjustment-progress:' || id::text AND key_version > 0
    AND octet_length(nonce)=12 AND octet_length(auth_tag)=16
    AND octet_length(ciphertext) BETWEEN 2 AND 20000)
);
CREATE UNIQUE INDEX hr_adjustment_closed_once ON app.hr_adjustment_progress_events(decision_id) WHERE action='closed';

REVOKE ALL ON app.hr_leave_policies,app.hr_leave_requests,app.hr_leave_request_events,
  app.hr_leave_request_days,app.hr_leave_entitlement_entries,app.hr_holiday_pay_records,
  app.hr_sickness_absences,app.hr_health_records,app.hr_adjustment_requests,
  app.hr_adjustment_decisions,app.hr_adjustment_progress_events FROM pms_app;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['hr_leave_policies','hr_leave_requests','hr_leave_request_events',
    'hr_leave_request_days','hr_leave_entitlement_entries','hr_holiday_pay_records',
    'hr_sickness_absences','hr_health_records','hr_adjustment_requests',
    'hr_adjustment_decisions','hr_adjustment_progress_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I_protected_insert BEFORE INSERT ON app.%I FOR EACH ROW EXECUTE FUNCTION app.protect_hr_insert()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_fixed BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.refuse_hr_history_change()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_hr_truncate()',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION app.create_hr_leave_policy(selected_effective date, selected_month smallint,
  selected_day smallint, selected_standard integer, selected_carry integer,
  selected_notice smallint, selected_route text, actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid; next_version integer;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_leave_policies',0));
  SELECT coalesce(max(version),0)+1 INTO next_version FROM app.hr_leave_policies;
  IF selected_effective <= coalesce((SELECT max(effective_from) FROM app.hr_leave_policies),DATE '0001-01-01') THEN
    RAISE EXCEPTION 'leave policy dates must move forward' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_leave_policies(version,effective_from,leave_year_month,leave_year_day,
    standard_entitlement_minutes,carry_over_limit_minutes,booking_notice_days,annual_approval_route,recorded_by)
    VALUES(next_version,selected_effective,selected_month,selected_day,selected_standard,selected_carry,
      selected_notice,selected_route,actor_id)
    RETURNING id INTO created_id;
  RETURN created_id;
END $$;
REVOKE ALL ON FUNCTION app.create_hr_leave_policy(date,smallint,smallint,integer,integer,smallint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_leave_policy(date,smallint,smallint,integer,integer,smallint,text,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_leave_entitlement(target_id uuid,target_person uuid,selected_year date,
  selected_kind text,selected_minutes integer,selected_context text,selected_key smallint,
  selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_leave:'||target_person::text||':'||selected_year::text,0));
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF selected_kind IN ('consumption','cancellation_return') THEN
    RAISE EXCEPTION 'request entries are system-generated' USING ERRCODE='insufficient_privilege';
  END IF;
  IF selected_kind='carry_over' AND selected_minutes > coalesce((SELECT carry_over_limit_minutes
      FROM app.hr_leave_policies WHERE effective_from<=selected_year
      ORDER BY effective_from DESC,version DESC LIMIT 1),-1) THEN
    RAISE EXCEPTION 'carry-over exceeds the recorded policy limit' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_leave_entitlement_entries(id,person_id,leave_year_start,kind,minutes,
    context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_person,selected_year,selected_kind,selected_minutes,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_leave_entitlement(uuid,uuid,date,text,integer,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_leave_entitlement(uuid,uuid,date,text,integer,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_leave_request(target_id uuid,target_person uuid,selected_kind text,
  selected_start date,selected_end date,selected_context text,selected_key smallint,
  selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text; policy app.hr_leave_policies%ROWTYPE; candidate date; selected_year date;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,false);
  IF allowed NOT IN ('self','hr') THEN RAISE EXCEPTION 'leave request access denied' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO policy FROM app.hr_leave_policies WHERE effective_from<=selected_start
    ORDER BY effective_from DESC,version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no leave policy applies' USING ERRCODE='check_violation'; END IF;
  candidate:=make_date(extract(year FROM selected_start)::integer,policy.leave_year_month,policy.leave_year_day);
  selected_year:=CASE WHEN selected_start<candidate THEN (candidate-INTERVAL '1 year')::date ELSE candidate END;
  IF selected_end>=selected_year+INTERVAL '1 year' THEN
    RAISE EXCEPTION 'a request must stay in one leave year' USING ERRCODE='check_violation';
  END IF;
  PERFORM 1 FROM app.hr_engagements WHERE person_id=target_person AND started_on<=selected_start
    AND (ended_on IS NULL OR ended_on>=selected_end) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the request is outside an engagement' USING ERRCODE='check_violation'; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_leave_requests(id,person_id,policy_id,kind,starts_on,ends_on,leave_year_start,
    context,key_version,nonce,ciphertext,auth_tag,submitted_by)
    VALUES(target_id,target_person,policy.id,selected_kind,selected_start,selected_end,selected_year,
      selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_leave_request(uuid,uuid,text,date,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_leave_request(uuid,uuid,text,date,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.decide_hr_leave_request(target_event uuid,target_request uuid,selected_action text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,target_entitlement uuid,entitlement_context text,entitlement_key smallint,
  entitlement_nonce bytea,entitlement_ciphertext bytea,entitlement_tag bytea,actor_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE request app.hr_leave_requests%ROWTYPE; allowed text; subject_account uuid; approval_route text;
  total_minutes integer; current_balance bigint;
BEGIN
  SELECT * INTO request FROM app.hr_leave_requests WHERE id=target_request FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,request.person_id,true);
  SELECT account_id INTO subject_account FROM app.hr_people WHERE id=request.person_id;
  IF actor_id=subject_account OR allowed='self' OR (allowed='manager' AND request.kind<>'annual') THEN
    RAISE EXCEPTION 'this actor cannot decide the leave request' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT annual_approval_route INTO approval_route FROM app.hr_leave_policies WHERE id=request.policy_id;
  IF allowed='manager' AND approval_route<>'manager_or_hr' THEN
    RAISE EXCEPTION 'this leave policy requires HR approval' USING ERRCODE='insufficient_privilege';
  END IF;
  IF selected_action NOT IN ('approved','refused') OR EXISTS(
      SELECT 1 FROM app.hr_leave_request_events WHERE request_id=target_request AND action IN ('approved','refused')) THEN
    RAISE EXCEPTION 'the leave request already has a decision' USING ERRCODE='check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_leave:'||request.person_id::text||':'||request.leave_year_start::text,0));
  PERFORM set_config('app.hr_write','1',true);
  IF selected_action='approved' THEN
    WITH requested_days AS (
      SELECT day::date AS leave_on,
        CASE extract(isodow FROM day)::integer
          WHEN 1 THEN pattern.monday_minutes WHEN 2 THEN pattern.tuesday_minutes
          WHEN 3 THEN pattern.wednesday_minutes WHEN 4 THEN pattern.thursday_minutes
          WHEN 5 THEN pattern.friday_minutes WHEN 6 THEN pattern.saturday_minutes
          ELSE pattern.sunday_minutes END AS minutes
      FROM generate_series(request.starts_on,request.ends_on,INTERVAL '1 day') day
      LEFT JOIN LATERAL (
        SELECT p.* FROM app.hr_work_patterns p JOIN app.hr_engagements e ON e.id=p.engagement_id
        WHERE e.person_id=request.person_id AND e.started_on<=day::date
          AND (e.ended_on IS NULL OR e.ended_on>=day::date) AND p.effective_on<=day::date
        ORDER BY p.effective_on DESC,p.recorded_at DESC,p.id DESC LIMIT 1
      ) pattern ON true
    ) SELECT sum(minutes)::integer INTO total_minutes FROM requested_days;
    IF total_minutes IS NULL OR total_minutes<=0 THEN
      RAISE EXCEPTION 'the request contains no working minutes' USING ERRCODE='check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.hr_leave_request_days d
      WHERE d.person_id=request.person_id AND d.leave_on BETWEEN request.starts_on AND request.ends_on
        AND EXISTS(SELECT 1 FROM app.hr_leave_request_events e WHERE e.request_id=d.request_id AND e.action='approved')
        AND NOT EXISTS(SELECT 1 FROM app.hr_leave_request_events e WHERE e.request_id=d.request_id AND e.action='cancelled')) THEN
      RAISE EXCEPTION 'approved leave cannot overlap' USING ERRCODE='check_violation';
    END IF;
    IF request.kind='annual' THEN
      SELECT coalesce(sum(minutes),0) INTO current_balance FROM app.hr_leave_entitlement_entries
        WHERE person_id=request.person_id AND leave_year_start=request.leave_year_start;
      IF current_balance<total_minutes THEN
        RAISE EXCEPTION 'annual leave balance is insufficient' USING ERRCODE='check_violation';
      END IF;
    END IF;
    INSERT INTO app.hr_leave_request_days(request_id,person_id,leave_on,minutes)
      SELECT request.id,request.person_id,day::date,
        CASE extract(isodow FROM day)::integer
          WHEN 1 THEN pattern.monday_minutes WHEN 2 THEN pattern.tuesday_minutes
          WHEN 3 THEN pattern.wednesday_minutes WHEN 4 THEN pattern.thursday_minutes
          WHEN 5 THEN pattern.friday_minutes WHEN 6 THEN pattern.saturday_minutes ELSE pattern.sunday_minutes END
      FROM generate_series(request.starts_on,request.ends_on,INTERVAL '1 day') day
      JOIN LATERAL (
        SELECT p.* FROM app.hr_work_patterns p JOIN app.hr_engagements e ON e.id=p.engagement_id
        WHERE e.person_id=request.person_id AND e.started_on<=day::date
          AND (e.ended_on IS NULL OR e.ended_on>=day::date) AND p.effective_on<=day::date
        ORDER BY p.effective_on DESC,p.recorded_at DESC,p.id DESC LIMIT 1
      ) pattern ON true
      WHERE CASE extract(isodow FROM day)::integer
        WHEN 1 THEN pattern.monday_minutes WHEN 2 THEN pattern.tuesday_minutes
        WHEN 3 THEN pattern.wednesday_minutes WHEN 4 THEN pattern.thursday_minutes
        WHEN 5 THEN pattern.friday_minutes WHEN 6 THEN pattern.saturday_minutes ELSE pattern.sunday_minutes END > 0;
    IF request.kind='annual' THEN
      INSERT INTO app.hr_leave_entitlement_entries(id,person_id,leave_year_start,kind,minutes,
        leave_request_id,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
        VALUES(target_entitlement,request.person_id,request.leave_year_start,'consumption',-total_minutes,
          request.id,entitlement_context,entitlement_key,entitlement_nonce,entitlement_ciphertext,entitlement_tag,actor_id);
    END IF;
  ELSE total_minutes:=0; END IF;
  INSERT INTO app.hr_leave_request_events(id,request_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_event,target_request,selected_action,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
  RETURN total_minutes;
END $$;
REVOKE ALL ON FUNCTION app.decide_hr_leave_request(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_hr_leave_request(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.cancel_hr_leave_request(target_event uuid,target_request uuid,selected_context text,
  selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,
  target_entitlement uuid,entitlement_context text,entitlement_key smallint,entitlement_nonce bytea,
  entitlement_ciphertext bytea,entitlement_tag bytea,actor_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE request app.hr_leave_requests%ROWTYPE; allowed text; approved boolean; used integer;
BEGIN
  SELECT * INTO request FROM app.hr_leave_requests WHERE id=target_request FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,request.person_id,false);
  IF allowed NOT IN ('self','hr') THEN RAISE EXCEPTION 'leave cancellation access denied' USING ERRCODE='insufficient_privilege'; END IF;
  IF EXISTS(SELECT 1 FROM app.hr_leave_request_events WHERE request_id=target_request AND action IN ('refused','cancelled')) THEN
    RAISE EXCEPTION 'the leave request cannot be cancelled' USING ERRCODE='check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_leave:'||request.person_id::text||':'||request.leave_year_start::text,0));
  approved:=EXISTS(SELECT 1 FROM app.hr_leave_request_events WHERE request_id=target_request AND action='approved');
  SELECT coalesce(sum(minutes),0)::integer INTO used FROM app.hr_leave_request_days WHERE request_id=target_request;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_leave_request_events(id,request_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_event,target_request,'cancelled',selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
  IF approved AND request.kind='annual' AND used>0 THEN
    INSERT INTO app.hr_leave_entitlement_entries(id,person_id,leave_year_start,kind,minutes,
      leave_request_id,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
      VALUES(target_entitlement,request.person_id,request.leave_year_start,'cancellation_return',used,
        request.id,entitlement_context,entitlement_key,entitlement_nonce,entitlement_ciphertext,entitlement_tag,actor_id);
  END IF;
  RETURN CASE WHEN approved THEN used ELSE 0 END;
END $$;
REVOKE ALL ON FUNCTION app.cancel_hr_leave_request(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_hr_leave_request(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_holiday_pay(target_person uuid,target_request uuid,selected_start date,
  selected_end date,selected_amount bigint,selected_basis text,selected_elements jsonb,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE created_id uuid;
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_leave_requests r WHERE r.id=target_request AND r.person_id=target_person AND r.kind='annual'
    AND EXISTS(SELECT 1 FROM app.hr_leave_request_events e WHERE e.request_id=r.id AND e.action='approved') FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  IF jsonb_typeof(selected_elements)<>'array' OR jsonb_array_length(selected_elements) NOT BETWEEN 1 AND 20
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(selected_elements) element
        WHERE jsonb_typeof(element)<>'object' OR jsonb_typeof(element->'name')<>'string'
          OR jsonb_typeof(element->'amountPence')<>'number'
          OR NOT app.is_safe_text(element->>'name') OR length(element->>'name') NOT BETWEEN 1 AND 100
          OR EXISTS(SELECT 1 FROM jsonb_object_keys(element) key WHERE key NOT IN ('name','amountPence'))) THEN
    RAISE EXCEPTION 'holiday pay elements must be safe text' USING ERRCODE='check_violation';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(selected_elements) element
      WHERE (element->>'amountPence')::numeric <> trunc((element->>'amountPence')::numeric)
        OR (element->>'amountPence')::numeric NOT BETWEEN 0 AND 9007199254740991)
      OR (SELECT sum((element->>'amountPence')::numeric) FROM jsonb_array_elements(selected_elements) element)
        <> selected_amount THEN
    RAISE EXCEPTION 'holiday pay elements must total the recorded amount' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_holiday_pay_records(person_id,leave_request_id,period_starts_on,period_ends_on,
    amount_pence,basis,included_elements,retention_until,recorded_by)
    VALUES(target_person,target_request,selected_start,selected_end,selected_amount,selected_basis,selected_elements,
      (clock_timestamp() AT TIME ZONE 'Europe/London')::date+INTERVAL '6 years',actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END $$;
REVOKE ALL ON FUNCTION app.record_hr_holiday_pay(uuid,uuid,date,date,bigint,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_holiday_pay(uuid,uuid,date,date,bigint,text,jsonb,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_sickness(target_person uuid,selected_start date,selected_end date,
  selected_notified timestamptz,selected_fitness text,actor_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text; created_id uuid;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF allowed NOT IN ('hr','manager') THEN RAISE EXCEPTION 'sickness administration access denied' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('app.hr_sickness:'||target_person::text,0));
  IF EXISTS(SELECT 1 FROM app.hr_sickness_absences WHERE person_id=target_person
      AND daterange(started_on,coalesce(ended_on,'infinity'::date),'[]') && daterange(selected_start,coalesce(selected_end,'infinity'::date),'[]')) THEN
    RAISE EXCEPTION 'sickness absence cannot overlap' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_sickness_absences(person_id,started_on,ended_on,notified_at,fitness_status,recorded_by)
    VALUES(target_person,selected_start,selected_end,selected_notified,selected_fitness,actor_id) RETURNING id INTO created_id;
  RETURN created_id;
END $$;
REVOKE ALL ON FUNCTION app.record_hr_sickness(uuid,date,date,timestamptz,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_sickness(uuid,date,date,timestamptz,text,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_health(target_id uuid,target_person uuid,selected_kind text,
  selected_from date,selected_to date,selected_context text,selected_key smallint,
  selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_people WHERE id=target_person FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_health_records(id,person_id,kind,valid_from,valid_to,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_person,selected_kind,selected_from,selected_to,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_health(uuid,uuid,text,date,date,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_health(uuid,uuid,text,date,date,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.create_hr_adjustment_request(target_id uuid,target_person uuid,selected_context text,
  selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,false);
  IF allowed NOT IN ('self','hr') THEN RAISE EXCEPTION 'adjustment request access denied' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_adjustment_requests(id,person_id,context,key_version,nonce,ciphertext,auth_tag,submitted_by)
    VALUES(target_id,target_person,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.create_hr_adjustment_request(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_hr_adjustment_request(uuid,uuid,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

CREATE FUNCTION app.decide_hr_adjustment(target_id uuid,target_request uuid,selected_outcome text,
  private_context text,private_key smallint,private_nonce bytea,private_ciphertext bytea,private_tag bytea,
  operational_context text,operational_key smallint,operational_nonce bytea,operational_ciphertext bytea,
  operational_tag bytea,selected_effective date,selected_review date,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  PERFORM 1 FROM app.hr_adjustment_requests WHERE id=target_request FOR UPDATE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_adjustment_decisions(id,request_id,outcome,private_context,private_key_version,
    private_nonce,private_ciphertext,private_auth_tag,operational_context,operational_key_version,
    operational_nonce,operational_ciphertext,operational_auth_tag,effective_on,review_on,recorded_by)
    VALUES(target_id,target_request,selected_outcome,private_context,private_key,private_nonce,private_ciphertext,private_tag,
      operational_context,operational_key,operational_nonce,operational_ciphertext,operational_tag,
      selected_effective,selected_review,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.decide_hr_adjustment(uuid,uuid,text,text,smallint,bytea,bytea,bytea,text,smallint,bytea,bytea,bytea,date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.decide_hr_adjustment(uuid,uuid,text,text,smallint,bytea,bytea,bytea,text,smallint,bytea,bytea,bytea,date,date,uuid) TO pms_app;

CREATE FUNCTION app.record_hr_adjustment_progress(target_id uuid,target_decision uuid,selected_action text,
  selected_context text,selected_key smallint,selected_nonce bytea,selected_ciphertext bytea,
  selected_tag bytea,actor_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target_person uuid; allowed text;
BEGIN
  SELECT request.person_id INTO target_person FROM app.hr_adjustment_decisions decision
    JOIN app.hr_adjustment_requests request ON request.id=decision.request_id
    WHERE decision.id=target_decision AND decision.outcome='agreed' FOR UPDATE OF decision;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF allowed='self' OR (allowed='manager' AND selected_action='closed') THEN
    RAISE EXCEPTION 'adjustment progress access denied' USING ERRCODE='insufficient_privilege';
  END IF;
  IF EXISTS(SELECT 1 FROM app.hr_adjustment_progress_events WHERE decision_id=target_decision AND action='closed') THEN
    RAISE EXCEPTION 'the adjustment is closed' USING ERRCODE='check_violation';
  END IF;
  PERFORM set_config('app.hr_write','1',true);
  INSERT INTO app.hr_adjustment_progress_events(id,decision_id,action,context,key_version,nonce,ciphertext,auth_tag,recorded_by)
    VALUES(target_id,target_decision,selected_action,selected_context,selected_key,selected_nonce,selected_ciphertext,selected_tag,actor_id);
END $$;
REVOKE ALL ON FUNCTION app.record_hr_adjustment_progress(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_hr_adjustment_progress(uuid,uuid,text,text,smallint,bytea,bytea,bytea,uuid) TO pms_app;

-- Reads return protected rows; response shaping and decryption stay in the API.
CREATE FUNCTION app.read_hr_leave_policies(actor_id uuid) RETURNS SETOF app.hr_leave_policies
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_active_hr(actor_id); RETURN QUERY SELECT * FROM app.hr_leave_policies ORDER BY effective_from DESC,version DESC; END $$;
REVOKE ALL ON FUNCTION app.read_hr_leave_policies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_leave_policies(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_leave_requests(target_person uuid,actor_id uuid)
RETURNS TABLE(id uuid,person_id uuid,policy_id uuid,kind text,starts_on date,ends_on date,leave_year_start date,
  context text,key_version smallint,nonce bytea,ciphertext bytea,auth_tag bytea,submitted_by uuid,
  submitted_at timestamptz,state text,decision_context text,decision_key_version smallint,
  decision_nonce bytea,decision_ciphertext bytea,decision_auth_tag bytea,decided_by uuid,
  decided_at timestamptz,approved_minutes integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT r.id,r.person_id,r.policy_id,r.kind,r.starts_on,r.ends_on,r.leave_year_start,
    r.context,r.key_version,r.nonce,r.ciphertext,r.auth_tag,r.submitted_by,r.submitted_at,
    CASE WHEN cancel.id IS NOT NULL THEN 'cancelled' WHEN decision.id IS NULL THEN 'pending' ELSE decision.action END,
    coalesce(cancel.context,decision.context),coalesce(cancel.key_version,decision.key_version),
    coalesce(cancel.nonce,decision.nonce),coalesce(cancel.ciphertext,decision.ciphertext),
    coalesce(cancel.auth_tag,decision.auth_tag),coalesce(cancel.recorded_by,decision.recorded_by),
    coalesce(cancel.recorded_at,decision.recorded_at),
    coalesce((SELECT sum(d.minutes)::integer FROM app.hr_leave_request_days d WHERE d.request_id=r.id),0)
  FROM app.hr_leave_requests r
  LEFT JOIN app.hr_leave_request_events decision ON decision.request_id=r.id AND decision.action IN ('approved','refused')
  LEFT JOIN app.hr_leave_request_events cancel ON cancel.request_id=r.id AND cancel.action='cancelled'
  WHERE r.person_id=target_person ORDER BY r.submitted_at DESC,r.id DESC;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_leave_requests(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_leave_requests(uuid,uuid) TO pms_app;

CREATE FUNCTION app.list_hr_pending_leave_requests(actor_id uuid)
RETURNS TABLE(id uuid,person_id uuid,account_id uuid,display_name text,policy_id uuid,kind text,starts_on date,
  ends_on date,leave_year_start date,context text,key_version smallint,nonce bytea,ciphertext bytea,
  auth_tag bytea,submitted_by uuid,submitted_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM app.assert_active_hr(actor_id);
  RETURN QUERY SELECT r.id,r.person_id,p.account_id,a.display_name,r.policy_id,r.kind,r.starts_on,r.ends_on,
    r.leave_year_start,r.context,r.key_version,r.nonce,r.ciphertext,r.auth_tag,r.submitted_by,r.submitted_at
  FROM app.hr_leave_requests r JOIN app.hr_people p ON p.id=r.person_id
  JOIN app.accounts a ON a.id=p.account_id
  WHERE NOT EXISTS(SELECT 1 FROM app.hr_leave_request_events event
    WHERE event.request_id=r.id AND event.action IN ('approved','refused','cancelled'))
  ORDER BY r.submitted_at,r.id;
END $$;
REVOKE ALL ON FUNCTION app.list_hr_pending_leave_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_pending_leave_requests(uuid) TO pms_app;

CREATE FUNCTION app.read_hr_leave_entitlement(target_person uuid,actor_id uuid)
RETURNS SETOF app.hr_leave_entitlement_entries LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT * FROM app.hr_leave_entitlement_entries WHERE person_id=target_person ORDER BY recorded_at,id; END $$;
REVOKE ALL ON FUNCTION app.read_hr_leave_entitlement(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_leave_entitlement(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_holiday_pay(target_person uuid,actor_id uuid)
RETURNS SETOF app.hr_holiday_pay_records LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN allowed:=app.assert_hr_person_access(actor_id,target_person,false);
  RETURN QUERY SELECT * FROM app.hr_holiday_pay_records WHERE person_id=target_person ORDER BY period_starts_on DESC,id DESC; END $$;
REVOKE ALL ON FUNCTION app.read_hr_holiday_pay(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_holiday_pay(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_sickness(target_person uuid,actor_id uuid)
RETURNS SETOF app.hr_sickness_absences LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_hr_person_access(actor_id,target_person,true);
  RETURN QUERY SELECT * FROM app.hr_sickness_absences WHERE person_id=target_person ORDER BY started_on DESC,id DESC; END $$;
REVOKE ALL ON FUNCTION app.read_hr_sickness(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_sickness(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_health(target_person uuid,actor_id uuid)
RETURNS SETOF app.hr_health_records LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM app.assert_hr_person_access(actor_id,target_person,false);
  RETURN QUERY SELECT * FROM app.hr_health_records WHERE person_id=target_person ORDER BY recorded_at DESC,id DESC; END $$;
REVOKE ALL ON FUNCTION app.read_hr_health(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_health(uuid,uuid) TO pms_app;

CREATE FUNCTION app.read_hr_adjustments(target_person uuid,actor_id uuid,manager_projection boolean)
RETURNS TABLE(request_id uuid,person_id uuid,request_context text,request_key_version smallint,
  request_nonce bytea,request_ciphertext bytea,request_auth_tag bytea,submitted_by uuid,submitted_at timestamptz,
  decision_id uuid,outcome text,private_context text,private_key_version smallint,private_nonce bytea,
  private_ciphertext bytea,private_auth_tag bytea,operational_context text,operational_key_version smallint,
  operational_nonce bytea,operational_ciphertext bytea,operational_auth_tag bytea,effective_on date,review_on date,
  decided_by uuid,decided_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN
  allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF manager_projection AND allowed<>'manager' THEN RAISE EXCEPTION 'manager projection required' USING ERRCODE='insufficient_privilege'; END IF;
  IF NOT manager_projection AND allowed='manager' THEN RAISE EXCEPTION 'private adjustment access denied' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN QUERY SELECT r.id,r.person_id,
    CASE WHEN allowed='manager' THEN NULL ELSE r.context END,
    CASE WHEN allowed='manager' THEN NULL ELSE r.key_version END,
    CASE WHEN allowed='manager' THEN NULL ELSE r.nonce END,
    CASE WHEN allowed='manager' THEN NULL ELSE r.ciphertext END,
    CASE WHEN allowed='manager' THEN NULL ELSE r.auth_tag END,r.submitted_by,r.submitted_at,
    d.id,d.outcome,
    CASE WHEN allowed='manager' THEN NULL ELSE d.private_context END,
    CASE WHEN allowed='manager' THEN NULL ELSE d.private_key_version END,
    CASE WHEN allowed='manager' THEN NULL ELSE d.private_nonce END,
    CASE WHEN allowed='manager' THEN NULL ELSE d.private_ciphertext END,
    CASE WHEN allowed='manager' THEN NULL ELSE d.private_auth_tag END,
    d.operational_context,d.operational_key_version,d.operational_nonce,d.operational_ciphertext,
    d.operational_auth_tag,d.effective_on,d.review_on,d.recorded_by,d.recorded_at
  FROM app.hr_adjustment_requests r LEFT JOIN app.hr_adjustment_decisions d ON d.request_id=r.id
  WHERE r.person_id=target_person ORDER BY r.submitted_at DESC,r.id DESC;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_adjustments(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_adjustments(uuid,uuid,boolean) TO pms_app;

CREATE FUNCTION app.read_hr_adjustment_progress(target_person uuid,actor_id uuid,manager_projection boolean)
RETURNS SETOF app.hr_adjustment_progress_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE allowed text;
BEGIN allowed:=app.assert_hr_person_access(actor_id,target_person,true);
  IF manager_projection AND allowed<>'manager' THEN RAISE EXCEPTION 'manager projection required' USING ERRCODE='insufficient_privilege'; END IF;
  IF NOT manager_projection AND allowed='manager' THEN RAISE EXCEPTION 'private adjustment access denied' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN QUERY SELECT event.* FROM app.hr_adjustment_progress_events event
    JOIN app.hr_adjustment_decisions decision ON decision.id=event.decision_id
    JOIN app.hr_adjustment_requests request ON request.id=decision.request_id
    WHERE request.person_id=target_person ORDER BY event.recorded_at,event.id;
END $$;
REVOKE ALL ON FUNCTION app.read_hr_adjustment_progress(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_hr_adjustment_progress(uuid,uuid,boolean) TO pms_app;
