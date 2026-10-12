-- Screen-facing HR projections. They expose no new private fields: the
-- directory fields below are already available to every active staff member.

CREATE FUNCTION app.list_hr_reports(actor_id uuid)
RETURNS TABLE(person_id uuid, account_id uuid, display_name text, work_email text,
  job_title text, team text, work_location text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM app.accounts
    WHERE id = actor_id AND kind = 'staff' AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active staff access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT person.id, account.id, account.display_name, account.email,
    terms.job_title, terms.team, terms.work_location
  FROM app.hr_people person
  JOIN app.accounts account ON account.id = person.account_id
    AND account.kind = 'staff' AND account.status = 'active'
  JOIN app.hr_engagements engagement ON engagement.person_id = person.id
    AND engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    AND (engagement.ended_on IS NULL OR engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date)
  JOIN LATERAL (
    SELECT item.manager_person_id FROM app.hr_manager_events item
    WHERE item.person_id = person.id
      AND item.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    ORDER BY item.effective_on DESC, item.recorded_at DESC, item.id DESC LIMIT 1
  ) manager_event ON true
  JOIN app.hr_people manager ON manager.id = manager_event.manager_person_id
    AND manager.account_id = actor_id
  JOIN app.hr_engagements manager_engagement ON manager_engagement.person_id = manager.id
    AND manager_engagement.started_on <= (clock_timestamp() AT TIME ZONE 'Europe/London')::date
    AND (manager_engagement.ended_on IS NULL OR manager_engagement.ended_on >= (clock_timestamp() AT TIME ZONE 'Europe/London')::date)
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

REVOKE ALL ON FUNCTION app.list_hr_reports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_hr_reports(uuid) TO pms_app;
