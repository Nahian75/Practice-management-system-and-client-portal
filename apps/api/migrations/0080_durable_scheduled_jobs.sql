-- Scheduling state survives replica replacement. Advisory ownership is held
-- on a reserved session connection, and releases when that connection closes.
CREATE TABLE app.scheduled_jobs (
  name text PRIMARY KEY CHECK(name ~ '^[a-z][a-z0-9_-]{2,63}$'),
  next_run_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON app.scheduled_jobs FROM pms_app;

CREATE FUNCTION app.scheduled_job_due(job_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF job_name !~ '^[a-z][a-z0-9_-]{2,63}$' THEN RAISE EXCEPTION 'Invalid job name'; END IF;
  INSERT INTO app.scheduled_jobs(name) VALUES(job_name) ON CONFLICT DO NOTHING;
  RETURN (SELECT next_run_at<=clock_timestamp() FROM app.scheduled_jobs WHERE name=job_name);
END;
$$;
CREATE FUNCTION app.defer_scheduled_job(job_name text,delay_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF job_name !~ '^[a-z][a-z0-9_-]{2,63}$' OR delay_seconds NOT BETWEEN 1 AND 86400 THEN RAISE EXCEPTION 'Invalid job schedule'; END IF;
  INSERT INTO app.scheduled_jobs(name,next_run_at) VALUES(job_name,clock_timestamp()+make_interval(secs=>delay_seconds))
  ON CONFLICT(name) DO UPDATE SET next_run_at=excluded.next_run_at;
END;
$$;
CREATE FUNCTION app.wake_scheduled_job(job_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF job_name !~ '^[a-z][a-z0-9_-]{2,63}$' THEN RAISE EXCEPTION 'Invalid job name'; END IF;
  INSERT INTO app.scheduled_jobs(name,next_run_at) VALUES(job_name,clock_timestamp())
  ON CONFLICT(name) DO UPDATE SET next_run_at=excluded.next_run_at;
END;
$$;
REVOKE ALL ON FUNCTION app.scheduled_job_due(text),app.defer_scheduled_job(text,integer),app.wake_scheduled_job(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scheduled_job_due(text),app.defer_scheduled_job(text,integer),app.wake_scheduled_job(text) TO pms_app;

-- Retry only missing/stale subject screenings, including clients with existing
-- confirmed/possible matches. Those concerns must not hide a new-list refresh.
CREATE FUNCTION app.aml_pending_rescreen_clients(after_client uuid,max_rows integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT DISTINCT m.client_id FROM app.matters m
  CROSS JOIN app.aml_sanctions_status() list
  WHERE m.status<>'closed' AND list.fresh AND (after_client IS NULL OR m.client_id>after_client)
    AND EXISTS (
      SELECT ref FROM (
        SELECT 'client'::text AS ref UNION ALL
        SELECT s.id::text FROM app.aml_cdd_subjects s WHERE s.cdd_case_id=(
          SELECT id FROM app.aml_cdd_cases WHERE client_id=m.client_id AND status='submitted' ORDER BY version DESC LIMIT 1)
      ) required
      WHERE NOT EXISTS(SELECT 1 FROM app.aml_screenings screening
        WHERE screening.client_id=m.client_id AND screening.subject_ref=required.ref AND screening.list_id=list.list_id
        AND screening.screened_at>=coalesce(app.aml_identity_changed_at(m.client_id),'-infinity'))
    )
  ORDER BY m.client_id LIMIT least(greatest(max_rows,1),500)
$$;
REVOKE ALL ON FUNCTION app.aml_pending_rescreen_clients(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aml_pending_rescreen_clients(uuid,integer) TO pms_app;
