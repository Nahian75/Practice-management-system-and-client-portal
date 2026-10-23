-- Compliance access to documents (docs/documents.md). Decided by the project
-- owner: compliance downloads a document of a matter they are not on only by
-- recording a reason for that one download. A download is a compliance access
-- like any other, naming the exact version, so it shares the role check, the
-- immutability, the hourly limit and the supervising partner's view.
ALTER TABLE app.matter_compliance_accesses
  ADD COLUMN document_version_id uuid REFERENCES app.document_versions (id);

GRANT INSERT (document_version_id) ON app.matter_compliance_accesses TO pms_app;

-- The version must belong to a document of the matter the access is for.
CREATE FUNCTION app.enforce_compliance_access_document() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM app.document_versions
    JOIN app.documents ON documents.id = document_versions.document_id
    WHERE document_versions.id = NEW.document_version_id AND documents.matter_id = NEW.matter_id
  ) THEN
    RAISE EXCEPTION 'a compliance access names a document of its own matter only'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_compliance_accesses_document
  BEFORE INSERT ON app.matter_compliance_accesses
  FOR EACH ROW EXECUTE FUNCTION app.enforce_compliance_access_document();
