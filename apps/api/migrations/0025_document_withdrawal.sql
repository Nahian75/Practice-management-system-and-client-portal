-- Withdrawing a document added by mistake (docs/documents.md, step 10c). A
-- withdrawn document is never deleted: its versions, and this record of who
-- withdrew it and why, are kept. The record is the only way a document becomes
-- withdrawn, and it cannot be undone. The reason is kept here, not in the
-- audit log.
CREATE TABLE app.document_withdrawals (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  document_id  uuid        NOT NULL REFERENCES app.documents (id),
  withdrawn_by uuid        NOT NULL REFERENCES app.accounts (id),
  reason       text        NOT NULL,
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT document_withdrawals_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT document_withdrawals_reason_safe CHECK (app.is_safe_text(reason))
);

CREATE UNIQUE INDEX document_withdrawals_one_per_document ON app.document_withdrawals (document_id);

REVOKE INSERT ON app.document_withdrawals FROM pms_app;
GRANT INSERT (document_id, withdrawn_by, reason) ON app.document_withdrawals TO pms_app;

-- Withdrawn by whoever added the document, or by the matter's supervising
-- partner; either must be on the team of an open matter. Takes the same
-- per-document lock as numbering a version, so a new version and a
-- withdrawal of the same document cannot interleave.
CREATE FUNCTION app.check_document_withdrawal() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  matter  uuid;
  creator uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.document_version:' || NEW.document_id::text, 0));
  SELECT matter_id, created_by INTO matter, creator FROM app.documents WHERE id = NEW.document_id;
  PERFORM app.check_document_writer(matter, NEW.withdrawn_by);
  IF NEW.withdrawn_by <> creator AND NOT EXISTS (
    SELECT 1 FROM app.matter_team
    WHERE matter_id = matter AND account_id = NEW.withdrawn_by
      AND role = 'supervising_partner' AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a document is withdrawn by whoever added it or by the matter''s supervising partner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_withdrawals_check
  BEFORE INSERT ON app.document_withdrawals
  FOR EACH ROW EXECUTE FUNCTION app.check_document_withdrawal();

-- A withdrawn document takes no new versions. This replaces the function from
-- 0024, adding that check after the lock; the rest is unchanged.
CREATE OR REPLACE FUNCTION app.number_document_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.check_document_writer(
    (SELECT matter_id FROM app.documents WHERE id = NEW.document_id),
    NEW.uploaded_by
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('app.document_version:' || NEW.document_id::text, 0));
  IF EXISTS (SELECT 1 FROM app.document_withdrawals WHERE document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'document % is withdrawn and takes no new versions', NEW.document_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM app.document_versions WHERE document_id = NEW.document_id;
  RETURN NEW;
END;
$$;
