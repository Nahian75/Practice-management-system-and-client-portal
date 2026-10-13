-- 0073_hr_security_review.sql
-- Security review hardening:
-- 1. Former-manager access revocation: Ensure assert_hr_person_access evaluates
--    the latest manager event using LIMIT 1, correctly revoking access when a
--    manager is cleared (manager_person_id IS NULL) rather than skipping the cleared
--    event and falling back to a superseded assignment.
-- 2. Leaver blockers: Include active HR confidential case memberships as blockers
--    in hr_leaver_blockers, preventing leaver checklists from being completed
--    while open confidential case proceedings are still assigned to the departing staff member.
-- 3. Role concurrency protection: Ensure assert_hr_case_member locks the qualifying
--    account_roles row with FOR SHARE when verifying active HR role for hr_member cases,
--    preventing concurrent role revocation from racing in-flight case operations.

CREATE OR REPLACE FUNCTION app.assert_hr_person_access(actor_id uuid, target_person uuid, allow_manager boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE target_account uuid; manager_account uuid; latest_manager_person uuid;
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
    SELECT event.manager_person_id INTO latest_manager_person
      FROM app.hr_manager_events event
      WHERE event.person_id = target_person
        AND event.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
      ORDER BY event.effective_on DESC, event.recorded_at DESC, event.id DESC LIMIT 1;
    IF latest_manager_person IS NOT NULL THEN
      SELECT manager.account_id INTO manager_account
        FROM app.hr_people manager
        WHERE manager.id = latest_manager_person
          AND EXISTS (SELECT 1 FROM app.hr_engagements worker_engagement
            WHERE worker_engagement.person_id = target_person
              AND worker_engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
              AND (worker_engagement.ended_on IS NULL OR worker_engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date))
          AND EXISTS (SELECT 1 FROM app.hr_engagements manager_engagement
            WHERE manager_engagement.person_id = manager.id
              AND manager_engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
              AND (manager_engagement.ended_on IS NULL OR manager_engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date));
      IF manager_account = actor_id THEN RETURN 'manager'; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'HR person access is not available' USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.assert_hr_person_access(uuid, uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.hr_leaver_blockers(target_checklist uuid)
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
  UNION ALL SELECT 'case_membership',m.case_id,c.kind FROM subject
    JOIN app.hr_case_memberships m ON m.account_id=subject.account_id
    JOIN app.hr_cases c ON c.id=m.case_id
    WHERE NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)
      AND COALESCE((SELECT state FROM app.hr_case_events WHERE case_id=c.id AND kind='status'
        ORDER BY recorded_at DESC,id DESC LIMIT 1),'open')<>'closed';
$$;
REVOKE ALL ON FUNCTION app.hr_leaver_blockers(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.assert_hr_case_member(target_case uuid,actor_id uuid,required_role text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts WHERE id=actor_id AND kind='staff' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active staff access required' USING ERRCODE='insufficient_privilege'; END IF;
  PERFORM 1 FROM app.hr_cases WHERE id=target_case FOR SHARE;
  IF NOT FOUND THEN RAISE NO_DATA_FOUND; END IF;
  PERFORM 1 FROM app.hr_case_memberships m
    WHERE m.case_id=target_case AND m.account_id=actor_id
      AND (required_role IS NULL OR m.role=required_role)
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'case membership required' USING ERRCODE='insufficient_privilege'; END IF;
  IF EXISTS (SELECT 1 FROM app.hr_case_memberships m WHERE m.case_id=target_case AND m.account_id=actor_id AND m.role='hr_member'
      AND NOT EXISTS (SELECT 1 FROM app.hr_case_membership_endings e WHERE e.membership_id=m.id)) THEN
    PERFORM 1 FROM app.account_roles r WHERE r.account_id=actor_id AND r.role='hr' AND r.revoked_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'live HR role required for HR case membership' USING ERRCODE='insufficient_privilege'; END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.assert_hr_case_member(uuid,uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.list_hr_cases(actor_id uuid)
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
