-- Portal security review. The database re-checks who may manage a link at
-- the write itself, and keeps every link row as an unchangeable history.
CREATE OR REPLACE FUNCTION app.check_portal_link() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  client_kind  text := (SELECT kind FROM app.clients WHERE id = NEW.client_id);
  record_email text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.account_id AND kind = 'client' AND status <> 'disabled') THEN
    RAISE EXCEPTION 'portal links are for client accounts that are not disabled'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM app.accounts actor
      JOIN app.clients client ON client.id = NEW.client_id
      WHERE actor.id = NEW.linked_by
        AND actor.kind = 'staff'
        AND actor.status = 'active'
        AND (
          client.responsible_id = actor.id
          OR EXISTS (
            SELECT 1
              FROM app.matters matter
              JOIN app.matter_team team ON team.matter_id = matter.id
              WHERE matter.client_id = client.id
                AND team.account_id = actor.id
                AND team.removed_at IS NULL
          )
        )
  ) THEN
    RAISE EXCEPTION 'portal links are managed only by active staff who can see the client'
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

CREATE OR REPLACE FUNCTION app.check_portal_link_end() RETURNS trigger
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
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.linked_by IS DISTINCT FROM OLD.linked_by
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION 'only a portal link''s end can be recorded'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM app.accounts actor
      JOIN app.clients client ON client.id = OLD.client_id
      WHERE actor.id = NEW.ended_by
        AND actor.kind = 'staff'
        AND actor.status = 'active'
        AND (
          client.responsible_id = actor.id
          OR EXISTS (
            SELECT 1
              FROM app.matters matter
              JOIN app.matter_team team ON team.matter_id = matter.id
              WHERE matter.client_id = client.id
                AND team.account_id = actor.id
                AND team.removed_at IS NULL
          )
        )
  ) THEN
    RAISE EXCEPTION 'portal links are managed only by active staff who can see the client'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.refuse_portal_link_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'portal links cannot be removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER portal_links_never_deleted
  BEFORE DELETE ON app.portal_links
  FOR EACH ROW EXECUTE FUNCTION app.refuse_portal_link_delete();
