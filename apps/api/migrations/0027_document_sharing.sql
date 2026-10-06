-- Sharing documents with the client (docs/portal.md, step 11b). Documents
-- start private. The current setting is kept on the document for safe portal
-- queries, but the app cannot change it directly: inserting an immutable
-- history row is the only route to a change.
ALTER TABLE app.documents
  ADD COLUMN shared_with_client boolean NOT NULL DEFAULT false;

CREATE TABLE app.document_sharing_changes (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  document_id uuid        NOT NULL REFERENCES app.documents (id),
  shared      boolean     NOT NULL,
  changed_by  uuid        NOT NULL REFERENCES app.accounts (id),
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX document_sharing_changes_document_idx
  ON app.document_sharing_changes (document_id, changed_at, id);

REVOKE INSERT ON app.document_sharing_changes FROM pms_app;
GRANT INSERT (document_id, shared, changed_by) ON app.document_sharing_changes TO pms_app;

-- The app has no UPDATE right on documents, so recording a sharing change is
-- what changes the setting. The document lock is also used by withdrawal and
-- versioning, so a document cannot be shared at the same moment it is
-- withdrawn. Repeating the current setting records nothing.
CREATE FUNCTION app.apply_document_sharing_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  matter        uuid;
  current_value boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.document_version:' || NEW.document_id::text, 0));

  SELECT matter_id, shared_with_client
    INTO matter, current_value
    FROM app.documents
    WHERE id = NEW.document_id;

  IF NOT EXISTS (
    SELECT 1
      FROM app.matter_team t
      JOIN app.accounts a ON a.id = t.account_id
      WHERE t.matter_id = matter
        AND t.account_id = NEW.changed_by
        AND t.removed_at IS NULL
        AND a.kind = 'staff'
        AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'document sharing is changed only by the active matter team'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.shared AND EXISTS (
    SELECT 1 FROM app.document_withdrawals WHERE document_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'a withdrawn document cannot be shared with the client'
      USING ERRCODE = 'check_violation';
  END IF;

  IF current_value = NEW.shared THEN
    RETURN NULL;
  END IF;

  UPDATE app.documents SET shared_with_client = NEW.shared WHERE id = NEW.document_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_document_sharing_change() FROM PUBLIC;

CREATE TRIGGER document_sharing_changes_apply
  BEFORE INSERT ON app.document_sharing_changes
  FOR EACH ROW EXECUTE FUNCTION app.apply_document_sharing_change();

-- A recorded change stays as it was, for every role.
CREATE FUNCTION app.refuse_document_sharing_change_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document sharing changes cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER document_sharing_changes_fixed
  BEFORE UPDATE OR DELETE ON app.document_sharing_changes
  FOR EACH ROW EXECUTE FUNCTION app.refuse_document_sharing_change_edit();

-- Withdrawal makes a shared document private in the same transaction and
-- records that change. This replaces the check from 0025; its other rules are
-- unchanged.
CREATE OR REPLACE FUNCTION app.check_document_withdrawal() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  matter  uuid;
  creator uuid;
  shared  boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.document_version:' || NEW.document_id::text, 0));
  SELECT matter_id, created_by, shared_with_client INTO matter, creator, shared
    FROM app.documents WHERE id = NEW.document_id;
  PERFORM app.check_document_writer(matter, NEW.withdrawn_by);
  IF NEW.withdrawn_by <> creator AND NOT EXISTS (
    SELECT 1 FROM app.matter_team
    WHERE matter_id = matter AND account_id = NEW.withdrawn_by
      AND role = 'supervising_partner' AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'a document is withdrawn by whoever added it or by the matter''s supervising partner'
      USING ERRCODE = 'check_violation';
  END IF;
  IF shared THEN
    INSERT INTO app.document_sharing_changes (document_id, shared, changed_by)
      VALUES (NEW.document_id, false, NEW.withdrawn_by);
  END IF;
  RETURN NEW;
END;
$$;
