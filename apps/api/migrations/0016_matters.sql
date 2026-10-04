-- Matters: one piece of work for a client. Never deleted: closed instead
-- (closing comes in a later step).
CREATE TABLE app.matters (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id   uuid        NOT NULL REFERENCES app.clients (id),
  number      integer     NOT NULL,
  reference   text        NOT NULL,
  title       text        NOT NULL,
  matter_type text        NOT NULL,
  status      text        NOT NULL DEFAULT 'open',
  opened_by   uuid        NOT NULL REFERENCES app.accounts (id),
  opened_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT matters_number_positive CHECK (number > 0),
  CONSTRAINT matters_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT matters_title_safe CHECK (app.is_safe_text(title)),
  CONSTRAINT matters_type_valid CHECK (matter_type IN (
    'residential_property', 'commercial_property', 'family', 'litigation', 'employment',
    'wills_probate', 'corporate', 'immigration', 'crime', 'other'
  )),
  CONSTRAINT matters_status_valid CHECK (status IN ('awaiting_clearance', 'open', 'closed'))
);

CREATE UNIQUE INDEX matters_client_number_key ON app.matters (client_id, number);
CREATE UNIQUE INDEX matters_reference_key ON app.matters (reference);

-- The app chooses the client, title, type and who opened it. Number,
-- reference and status come from the database.
REVOKE INSERT ON app.matters FROM pms_app;
GRANT INSERT (client_id, title, matter_type, opened_by) ON app.matters TO pms_app;

-- Numbers each client's matters 1, 2, 3 ... under a per-client lock, so two
-- matters opened at once for one client cannot get the same number, and
-- builds the reference from the client's: C-000123/001.
CREATE FUNCTION app.number_matter() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM app.accounts WHERE id = NEW.opened_by) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'matters are opened by staff accounts'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('app.matter_number:' || NEW.client_id::text, 0));
  SELECT coalesce(max(number), 0) + 1 INTO NEW.number FROM app.matters WHERE client_id = NEW.client_id;
  NEW.reference := (SELECT reference FROM app.clients WHERE id = NEW.client_id)
    || '/' || lpad(NEW.number::text, greatest(3, length(NEW.number::text)), '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER matters_number
  BEFORE INSERT ON app.matters
  FOR EACH ROW EXECUTE FUNCTION app.number_matter();

-- Who works on a matter. Removing someone closes their row (a later step);
-- rows are never deleted, so the history of who could see what is kept.
CREATE TABLE app.matter_team (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id  uuid        NOT NULL REFERENCES app.matters (id),
  account_id uuid        NOT NULL REFERENCES app.accounts (id),
  role       text        NOT NULL,
  added_by   uuid        NOT NULL REFERENCES app.accounts (id),
  added_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_by uuid        REFERENCES app.accounts (id),
  removed_at timestamptz,

  CONSTRAINT matter_team_role_valid CHECK (role IN ('supervising_partner', 'fee_earner')),
  CONSTRAINT matter_team_removal_complete CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

CREATE UNIQUE INDEX matter_team_one_active_membership ON app.matter_team (matter_id, account_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX matter_team_one_supervising_partner ON app.matter_team (matter_id)
  WHERE role = 'supervising_partner' AND removed_at IS NULL;
CREATE INDEX matter_team_account_idx ON app.matter_team (account_id) WHERE removed_at IS NULL;

REVOKE INSERT ON app.matter_team FROM pms_app;
GRANT INSERT (matter_id, account_id, role, added_by) ON app.matter_team TO pms_app;

-- Team members are active staff who hold a role that sees matters; a
-- supervising partner holds the partner role. The role list mirrors
-- ROLE_PERMISSIONS in permissions.ts (matters.view); a test checks every role
-- against both.
CREATE FUNCTION app.enforce_matter_team_member() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  allowed_roles text[] := CASE NEW.role
    WHEN 'supervising_partner' THEN ARRAY['partner']
    ELSE ARRAY['partner', 'fee_earner']
  END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.accounts WHERE id = NEW.account_id AND kind = 'staff' AND status = 'active') THEN
    RAISE EXCEPTION 'matter team members are active staff accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.account_roles
    WHERE account_id = NEW.account_id AND revoked_at IS NULL AND role = ANY (allowed_roles)
  ) THEN
    RAISE EXCEPTION 'a % must hold a role that allows it', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_team_member
  BEFORE INSERT ON app.matter_team
  FOR EACH ROW EXECUTE FUNCTION app.enforce_matter_team_member();

-- Every matter has a supervising partner from the start: checked when the
-- transaction that opens it commits.
CREATE FUNCTION app.enforce_matter_has_supervisor() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.matter_team
    WHERE matter_id = NEW.id AND role = 'supervising_partner' AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'matter % has no supervising partner', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER matters_have_supervisor
  AFTER INSERT ON app.matters
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_matter_has_supervisor();
