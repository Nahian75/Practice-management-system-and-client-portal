-- Who is responsible for a client, and so who can see it. Starts as the
-- creator; created_by stays as the historical record.
ALTER TABLE app.clients ADD COLUMN responsible_id uuid REFERENCES app.accounts (id);
UPDATE app.clients SET responsible_id = created_by;
ALTER TABLE app.clients ALTER COLUMN responsible_id SET NOT NULL;

CREATE INDEX clients_responsible_id_idx ON app.clients (responsible_id);

-- The app does not choose the responsible person on insert (its INSERT grant
-- names kind and created_by only): it is always the creator.
CREATE FUNCTION app.set_client_responsible_to_creator() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.responsible_id := NEW.created_by;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_responsible_is_creator
  BEFORE INSERT ON app.clients
  FOR EACH ROW EXECUTE FUNCTION app.set_client_responsible_to_creator();

-- Every change of responsibility, with the reason given. Never changed or
-- deleted. The reason is kept here rather than in the audit log, because
-- free text can hold personal data.
CREATE TABLE app.client_responsibility_changes (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id       uuid        NOT NULL REFERENCES app.clients (id),
  from_account_id uuid        NOT NULL REFERENCES app.accounts (id),
  to_account_id   uuid        NOT NULL REFERENCES app.accounts (id),
  reason          text        NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT client_responsibility_changes_reason_length CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  CONSTRAINT client_responsibility_changes_to_someone_else CHECK (from_account_id <> to_account_id)
);

CREATE INDEX client_responsibility_changes_client_idx ON app.client_responsibility_changes (client_id);

REVOKE INSERT ON app.client_responsibility_changes FROM pms_app;
GRANT INSERT (client_id, from_account_id, to_account_id, reason) ON app.client_responsibility_changes TO pms_app;

-- The only way to change responsible_id: the app has no UPDATE right on
-- clients, so recording a change is what applies it. The rules agreed by the
-- project owner are checked here, where no bug in the app can skip them.
-- SECURITY DEFINER runs this as the table owner, with a fixed search_path so
-- a caller cannot substitute their own tables or functions.
CREATE FUNCTION app.apply_client_responsibility_change() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  current_responsible uuid;
BEGIN
  SELECT responsible_id INTO current_responsible FROM app.clients WHERE id = NEW.client_id FOR UPDATE;
  IF current_responsible IS DISTINCT FROM NEW.from_account_id THEN
    RAISE EXCEPTION 'client % is not the responsibility of %', NEW.client_id, NEW.from_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT status FROM app.accounts WHERE id = NEW.from_account_id) IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'a client is taken over only from a disabled account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.to_account_id AND kind = 'staff' AND status = 'active') THEN
    RAISE EXCEPTION 'a client is taken over by an active staff account'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.clients SET responsible_id = NEW.to_account_id WHERE id = NEW.client_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_client_responsibility_change() FROM PUBLIC;

CREATE TRIGGER client_responsibility_changes_apply
  BEFORE INSERT ON app.client_responsibility_changes
  FOR EACH ROW EXECUTE FUNCTION app.apply_client_responsibility_change();

-- A recorded change stays as it was, for every role.
CREATE FUNCTION app.refuse_client_responsibility_change_edit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'responsibility changes cannot be altered or removed'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER client_responsibility_changes_fixed
  BEFORE UPDATE OR DELETE ON app.client_responsibility_changes
  FOR EACH ROW EXECUTE FUNCTION app.refuse_client_responsibility_change_edit();
