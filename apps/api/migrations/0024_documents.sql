-- Documents of a matter, and their versions (docs/documents.md). The files
-- themselves are encrypted in object storage; these rows say what they are
-- and hold each file's key, itself encrypted with the master key.
CREATE TABLE app.documents (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id  uuid        NOT NULL REFERENCES app.matters (id),
  title      text        NOT NULL,
  category   text        NOT NULL,
  created_by uuid        NOT NULL REFERENCES app.accounts (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT documents_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT documents_title_safe CHECK (app.is_safe_text(title)),
  CONSTRAINT documents_category_valid CHECK (category IN (
    'correspondence', 'contract', 'evidence', 'identity', 'court', 'other'
  ))
);

CREATE INDEX documents_matter_idx ON app.documents (matter_id, created_at DESC);

REVOKE INSERT ON app.documents FROM pms_app;
GRANT INSERT (matter_id, title, category, created_by) ON app.documents TO pms_app;

-- Every version is kept: the app can add versions, never change or remove one.
CREATE TABLE app.document_versions (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  document_id uuid        NOT NULL REFERENCES app.documents (id),
  number      integer     NOT NULL,
  file_name   text        NOT NULL,
  media_type  text        NOT NULL,
  size_bytes  integer     NOT NULL,
  sha256      bytea       NOT NULL,
  -- A random id, so the storage listing says nothing about the file.
  storage_key uuid        NOT NULL,
  -- The file's own key, sealed with the master key (AES-256-GCM, bound to storage_key).
  key_version smallint    NOT NULL,
  key_nonce   bytea       NOT NULL,
  wrapped_key bytea       NOT NULL,
  key_tag     bytea       NOT NULL,
  uploaded_by uuid        NOT NULL REFERENCES app.accounts (id),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT document_versions_number_positive CHECK (number > 0),
  -- The original name is kept as text only, never used as a path.
  CONSTRAINT document_versions_file_name_length CHECK (length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT document_versions_file_name_safe CHECK (
    app.is_safe_text(file_name) AND strpos(file_name, '/') = 0 AND strpos(file_name, chr(92)) = 0
  ),
  CONSTRAINT document_versions_media_type_valid CHECK (media_type IN (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'image/jpeg',
    'image/png',
    'message/rfc822'
  )),
  -- At most 50 MB (50 * 1024 * 1024 bytes).
  CONSTRAINT document_versions_size_valid CHECK (size_bytes BETWEEN 1 AND 52428800),
  CONSTRAINT document_versions_sha256_length CHECK (octet_length(sha256) = 32),
  CONSTRAINT document_versions_key_version_positive CHECK (key_version > 0),
  CONSTRAINT document_versions_key_nonce_length CHECK (octet_length(key_nonce) = 12),
  CONSTRAINT document_versions_wrapped_key_length CHECK (octet_length(wrapped_key) = 32),
  CONSTRAINT document_versions_key_tag_length CHECK (octet_length(key_tag) = 16)
);

CREATE UNIQUE INDEX document_versions_document_number_key ON app.document_versions (document_id, number);
CREATE UNIQUE INDEX document_versions_storage_key_key ON app.document_versions (storage_key);

REVOKE INSERT ON app.document_versions FROM pms_app;
GRANT INSERT (document_id, file_name, media_type, size_bytes, sha256, storage_key,
              key_version, key_nonce, wrapped_key, key_tag, uploaded_by)
  ON app.document_versions TO pms_app;

-- Only an active member of the matter's team adds documents and versions, and
-- only while the matter is open: not while a possible conflict awaits
-- clearance (no work should start), nor once it is closed.
CREATE FUNCTION app.check_document_writer(matter uuid, writer uuid) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM app.matters WHERE id = matter) IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'documents are added only to open matters'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.matter_team
    WHERE matter_id = matter AND account_id = writer AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'documents are added only by the matter''s team'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- The triggers below run as the app role, so it may run this check; it only refuses, never changes anything.
GRANT EXECUTE ON FUNCTION app.check_document_writer(uuid, uuid) TO pms_app;

CREATE FUNCTION app.check_new_document() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.check_document_writer(NEW.matter_id, NEW.created_by);
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_writer
  BEFORE INSERT ON app.documents
  FOR EACH ROW EXECUTE FUNCTION app.check_new_document();

-- Numbers each document's versions 1, 2, 3 ... under a per-document lock, so
-- two versions uploaded at once cannot get the same number.
CREATE FUNCTION app.number_document_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.check_document_writer(
    (SELECT matter_id FROM app.documents WHERE id = NEW.document_id),
    NEW.uploaded_by
  );
  PERFORM pg_advisory_xact_lock(hashtextextended('app.document_version:' || NEW.document_id::text, 0));
  SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM app.document_versions WHERE document_id = NEW.document_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_versions_number
  BEFORE INSERT ON app.document_versions
  FOR EACH ROW EXECUTE FUNCTION app.number_document_version();

-- A document is never left without a file: checked when the transaction commits.
CREATE FUNCTION app.check_document_has_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.document_versions WHERE document_id = NEW.id) THEN
    RAISE EXCEPTION 'a document needs at least one version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER documents_have_version
  AFTER INSERT ON app.documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_document_has_version();
