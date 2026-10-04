-- The people the firm deals with at an organisation client. A contact who
-- leaves is marked inactive, never deleted, so past correspondence still
-- says who it was with.
CREATE TABLE app.client_contacts (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id   uuid        NOT NULL REFERENCES app.clients (id),
  given_names text        NOT NULL,
  family_name text        NOT NULL,
  job_title   text,
  email       text,
  phone       text,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT client_contacts_given_names_length CHECK (length(btrim(given_names)) BETWEEN 1 AND 100),
  CONSTRAINT client_contacts_family_name_length CHECK (length(btrim(family_name)) BETWEEN 1 AND 100),
  CONSTRAINT client_contacts_job_title_length CHECK (length(btrim(job_title)) BETWEEN 1 AND 100),
  CONSTRAINT client_contacts_email_format
    CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT client_contacts_phone_format CHECK (phone ~ '^\+?[0-9 ()-]{6,30}$')
);

CREATE INDEX client_contacts_client_idx ON app.client_contacts (client_id);

-- Only organisations have contacts. Reuses the kind check written for details rows.
CREATE TRIGGER client_contacts_kind
  BEFORE INSERT ON app.client_contacts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_client_details_kind('organisation');

-- New contacts are active; a contact never moves to another client.
REVOKE INSERT ON app.client_contacts FROM pms_app;
GRANT INSERT (client_id, given_names, family_name, job_title, email, phone) ON app.client_contacts TO pms_app;
GRANT UPDATE (given_names, family_name, job_title, email, phone, active) ON app.client_contacts TO pms_app;
