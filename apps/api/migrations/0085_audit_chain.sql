-- Tamper evidence for the audit log (docs/audit.md). Decided by the project
-- owner: a hash chain, with its latest link emailed to compliance daily.
-- Each seal is SHA-256 of the previous seal and one event's content, computed
-- by the API (src/audit/chain/audit-digest.ts) and checked by a script
-- outside the database. A superuser who edits or deletes an event, or
-- rebuilds the chain, no longer matches a checkpoint already emailed.
CREATE TABLE app.audit_seals (
  seq       bigint      PRIMARY KEY,
  -- No foreign key: it would refuse TRUNCATE of audit_events before its own append-only trigger, and the check script reports a missing event anyway.
  event_id  uuid        NOT NULL UNIQUE,
  hash      bytea       NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT audit_seals_seq_positive CHECK (seq > 0),
  CONSTRAINT audit_seals_hash_length CHECK (octet_length(hash) = 32)
);

-- Which seal was emailed on each London day.
CREATE TABLE app.audit_checkpoints (
  london_date date        PRIMARY KEY,
  seq         bigint      NOT NULL REFERENCES app.audit_seals (seq),
  hash        bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT audit_checkpoints_hash_length CHECK (octet_length(hash) = 32)
);

CREATE TRIGGER audit_seals_reject_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_seals
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER audit_seals_reject_truncate
  BEFORE TRUNCATE ON app.audit_seals
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER audit_checkpoints_reject_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_event_change();
CREATE TRIGGER audit_checkpoints_reject_truncate
  BEFORE TRUNCATE ON app.audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_event_change();

REVOKE INSERT ON app.audit_seals, app.audit_checkpoints FROM pms_app;
GRANT INSERT (seq, event_id, hash) ON app.audit_seals TO pms_app;
GRANT INSERT (london_date, seq, hash) ON app.audit_checkpoints TO pms_app;
