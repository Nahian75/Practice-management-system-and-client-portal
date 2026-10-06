-- Which client accounts may see which clients in the portal (docs/portal.md).
-- A link is for an individual client themself, or for one contact of an
-- organisation client. Links are ended, never deleted, so who could see what,
-- and when, is kept.
CREATE TABLE app.portal_links (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid        NOT NULL REFERENCES app.accounts (id),
  client_id  uuid        NOT NULL REFERENCES app.clients (id),
  contact_id uuid        REFERENCES app.client_contacts (id),
  linked_by  uuid        NOT NULL REFERENCES app.accounts (id),
  linked_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_by   uuid        REFERENCES app.accounts (id),
  ended_at   timestamptz,

  CONSTRAINT portal_links_end_complete CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);

CREATE UNIQUE INDEX portal_links_one_active ON app.portal_links (account_id, client_id) WHERE ended_at IS NULL;
CREATE INDEX portal_links_client_idx ON app.portal_links (client_id) WHERE ended_at IS NULL;

REVOKE INSERT ON app.portal_links FROM pms_app;
GRANT INSERT (account_id, client_id, contact_id, linked_by) ON app.portal_links TO pms_app;
GRANT UPDATE (ended_at, ended_by) ON app.portal_links TO pms_app;

-- A link joins a client account, still usable, to a person on the client's
-- record: the individual client, or one active contact of an organisation.
-- Its email address must be the one on that record, so access can only ever
-- go to the address the firm holds for the person. Linked by staff.
CREATE FUNCTION app.check_portal_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  client_kind  text := (SELECT kind FROM app.clients WHERE id = NEW.client_id);
  record_email text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.account_id AND kind = 'client' AND status <> 'disabled') THEN
    RAISE EXCEPTION 'portal links are for client accounts that are not disabled'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT kind FROM app.accounts WHERE id = NEW.linked_by) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'portal links are made by staff'
      USING ERRCODE = 'check_violation';
  END IF;

  IF client_kind = 'individual' THEN
    IF NEW.contact_id IS NOT NULL THEN
      RAISE EXCEPTION 'a link to an individual client is for the client themself'
        USING ERRCODE = 'check_violation';
    END IF;
    record_email := (SELECT email FROM app.client_individuals WHERE client_id = NEW.client_id);
  ELSE
    record_email := (
      SELECT email FROM app.client_contacts
      WHERE id = NEW.contact_id AND client_id = NEW.client_id AND active
    );
    IF NEW.contact_id IS NULL OR record_email IS NULL THEN
      RAISE EXCEPTION 'a link to an organisation is for one of its active contacts, with an email address'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF record_email IS NULL
     OR lower(btrim(record_email)) IS DISTINCT FROM (SELECT email FROM app.accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'a portal link goes only to the email address on the client''s record'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_links_check
  BEFORE INSERT ON app.portal_links
  FOR EACH ROW EXECUTE FUNCTION app.check_portal_link();

-- A link is ended once, by staff, and stays ended.
CREATE FUNCTION app.check_portal_link_end() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'portal link % is already ended and cannot change', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'a change to a portal link can only end it'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT kind FROM app.accounts WHERE id = NEW.ended_by) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'portal links are ended by staff'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER portal_links_end_once
  BEFORE UPDATE ON app.portal_links
  FOR EACH ROW EXECUTE FUNCTION app.check_portal_link_end();
