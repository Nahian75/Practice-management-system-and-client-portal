-- Automated Ephemeral Security Data Retention (Review F3)
-- Purges expired sessions, stale sign-in failures, expired password resets,
-- expired invitations, and completed email outbox entries according to firm retention policies.
-- Runs with owner privileges via SECURITY DEFINER to enforce atomic, restricted deletion
-- without granting DELETE permissions on these sensitive tables to pms_app.

CREATE FUNCTION app.purge_expired_ephemeral_security_data(
  p_sessions_retention_days integer DEFAULT 30,
  p_failures_retention_days integer DEFAULT 90,
  p_resets_retention_days integer DEFAULT 7,
  p_invitations_retention_days integer DEFAULT 14,
  p_outbox_retention_days integer DEFAULT 30
)
RETURNS TABLE (
  purged_sessions integer,
  purged_sign_in_failures integer,
  purged_password_resets integer,
  purged_invitations integer,
  purged_email_outbox integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE
  v_sessions_count integer := 0;
  v_failures_count integer := 0;
  v_resets_count integer := 0;
  v_invitations_count integer := 0;
  v_outbox_count integer := 0;
  v_sessions_cutoff timestamptz;
  v_failures_cutoff timestamptz;
  v_resets_cutoff timestamptz;
  v_invitations_cutoff timestamptz;
  v_outbox_cutoff timestamptz;
BEGIN
  v_sessions_cutoff := clock_timestamp() - (GREATEST(1, p_sessions_retention_days) || ' days')::interval;
  v_failures_cutoff := clock_timestamp() - (GREATEST(1, p_failures_retention_days) || ' days')::interval;
  v_resets_cutoff := clock_timestamp() - (GREATEST(1, p_resets_retention_days) || ' days')::interval;
  v_invitations_cutoff := clock_timestamp() - (GREATEST(1, p_invitations_retention_days) || ' days')::interval;
  v_outbox_cutoff := clock_timestamp() - (GREATEST(1, p_outbox_retention_days) || ' days')::interval;

  -- 1. Sessions: purge sessions that ended before cutoff or expired before cutoff
  WITH deleted AS (
    DELETE FROM app.sessions
    WHERE (ended_at IS NOT NULL AND ended_at < v_sessions_cutoff)
       OR (ended_at IS NULL AND expires_at < v_sessions_cutoff)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_sessions_count FROM deleted;

  -- 2. Sign-in failures: purge failed sign-in records older than cutoff
  WITH deleted AS (
    DELETE FROM app.sign_in_failures
    WHERE occurred_at < v_failures_cutoff
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_failures_count FROM deleted;

  -- 3. Password resets: purge resets that were used before cutoff or expired before cutoff
  WITH deleted AS (
    DELETE FROM app.password_resets
    WHERE (closed_at IS NOT NULL AND closed_at < v_resets_cutoff)
       OR (closed_at IS NULL AND expires_at < v_resets_cutoff)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_resets_count FROM deleted;

  -- 4. Invitations: purge invitations that were closed before cutoff or expired before cutoff
  WITH deleted AS (
    DELETE FROM app.invitations
    WHERE (closed_at IS NOT NULL AND closed_at < v_invitations_cutoff)
       OR (closed_at IS NULL AND expires_at < v_invitations_cutoff)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_invitations_count FROM deleted;

  -- 5. Email outbox: purge terminal deliveries where encrypted payload was cleared
  WITH deleted AS (
    DELETE FROM app.email_outbox
    WHERE status IN ('sent', 'discarded', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at < v_outbox_cutoff
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_outbox_count FROM deleted;

  RETURN QUERY SELECT
    v_sessions_count,
    v_failures_count,
    v_resets_count,
    v_invitations_count,
    v_outbox_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.purge_expired_ephemeral_security_data FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_ephemeral_security_data TO pms_app;
