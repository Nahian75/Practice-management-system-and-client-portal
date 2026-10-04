-- Clients of the firm. Never deleted: a client is archived instead, so
-- matters, bills and the audit trail always resolve.
CREATE TABLE app.clients (
  id          uuid        PRIMARY KEY DEFAULT uuidv7(),
  number      bigint      GENERATED ALWAYS AS IDENTITY,
  reference   text        GENERATED ALWAYS AS ('C-' || lpad(number::text, greatest(6, length(number::text)), '0')) STORED,
  kind        text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active',
  created_by  uuid        NOT NULL REFERENCES app.accounts (id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT clients_kind_valid CHECK (kind IN ('individual', 'organisation')),
  CONSTRAINT clients_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE UNIQUE INDEX clients_number_key ON app.clients (number);
CREATE UNIQUE INDEX clients_reference_key ON app.clients (reference);
CREATE INDEX clients_created_by_idx ON app.clients (created_by);

-- The app chooses only the kind and the creator. Without a column list it
-- could insert OVERRIDING SYSTEM VALUE and pick its own reference.
REVOKE INSERT ON app.clients FROM pms_app;
GRANT INSERT (kind, created_by) ON app.clients TO pms_app;

-- Clients are created by staff. A cross-table rule, so a trigger rather than a CHECK.
CREATE FUNCTION app.enforce_client_creator_is_staff() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM app.accounts WHERE id = NEW.created_by) IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION 'clients are created by staff accounts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_creator_is_staff
  BEFORE INSERT ON app.clients
  FOR EACH ROW EXECUTE FUNCTION app.enforce_client_creator_is_staff();

CREATE TABLE app.client_individuals (
  client_id     uuid PRIMARY KEY REFERENCES app.clients (id),
  title         text,
  given_names   text NOT NULL,
  family_name   text NOT NULL,
  date_of_birth date,
  email         text,
  phone         text,
  address_line1 text,
  address_line2 text,
  town          text,
  postcode      text,
  country       text,

  CONSTRAINT client_individuals_title_length CHECK (length(btrim(title)) BETWEEN 1 AND 20),
  CONSTRAINT client_individuals_given_names_length CHECK (length(btrim(given_names)) BETWEEN 1 AND 100),
  CONSTRAINT client_individuals_family_name_length CHECK (length(btrim(family_name)) BETWEEN 1 AND 100),
  CONSTRAINT client_individuals_date_of_birth_plausible CHECK (date_of_birth >= DATE '1900-01-01'),
  CONSTRAINT client_individuals_email_format
    CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT client_individuals_phone_format CHECK (phone ~ '^\+?[0-9 ()-]{6,30}$'),
  CONSTRAINT client_individuals_address_line1_length CHECK (length(btrim(address_line1)) BETWEEN 1 AND 200),
  CONSTRAINT client_individuals_address_line2_length CHECK (length(btrim(address_line2)) BETWEEN 1 AND 200),
  CONSTRAINT client_individuals_town_length CHECK (length(btrim(town)) BETWEEN 1 AND 100),
  CONSTRAINT client_individuals_postcode_length CHECK (length(btrim(postcode)) BETWEEN 1 AND 16),
  CONSTRAINT client_individuals_country_code CHECK (country ~ '^[A-Z]{2}$'),
  -- An address is either absent or has at least a first line, a town and a country.
  CONSTRAINT client_individuals_address_complete CHECK (
    (address_line1 IS NULL AND address_line2 IS NULL AND town IS NULL AND postcode IS NULL AND country IS NULL)
    OR (address_line1 IS NOT NULL AND town IS NOT NULL AND country IS NOT NULL)
  )
);

CREATE TABLE app.client_organisations (
  client_id           uuid PRIMARY KEY REFERENCES app.clients (id),
  legal_name          text NOT NULL,
  organisation_type   text NOT NULL,
  registration_number text,
  email               text,
  phone               text,
  address_line1       text,
  address_line2       text,
  town                text,
  postcode            text,
  country             text,

  CONSTRAINT client_organisations_legal_name_length CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  CONSTRAINT client_organisations_type_valid
    CHECK (organisation_type IN ('company', 'llp', 'partnership', 'charity', 'trust', 'other')),
  CONSTRAINT client_organisations_registration_number_format CHECK (registration_number ~ '^[A-Z0-9]{1,30}$'),
  CONSTRAINT client_organisations_email_format
    CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  CONSTRAINT client_organisations_phone_format CHECK (phone ~ '^\+?[0-9 ()-]{6,30}$'),
  CONSTRAINT client_organisations_address_line1_length CHECK (length(btrim(address_line1)) BETWEEN 1 AND 200),
  CONSTRAINT client_organisations_address_line2_length CHECK (length(btrim(address_line2)) BETWEEN 1 AND 200),
  CONSTRAINT client_organisations_town_length CHECK (length(btrim(town)) BETWEEN 1 AND 100),
  CONSTRAINT client_organisations_postcode_length CHECK (length(btrim(postcode)) BETWEEN 1 AND 16),
  CONSTRAINT client_organisations_country_code CHECK (country ~ '^[A-Z]{2}$'),
  CONSTRAINT client_organisations_address_complete CHECK (
    (address_line1 IS NULL AND address_line2 IS NULL AND town IS NULL AND postcode IS NULL AND country IS NULL)
    OR (address_line1 IS NOT NULL AND town IS NOT NULL AND country IS NOT NULL)
  )
);

-- Details rows match the client's kind. With client_id as the primary key,
-- this leaves at most one details row per client, of the right kind.
CREATE FUNCTION app.enforce_client_details_kind() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT kind FROM app.clients WHERE id = NEW.client_id) IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION 'client % is not an % client', NEW.client_id, TG_ARGV[0]
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_individuals_kind
  BEFORE INSERT ON app.client_individuals
  FOR EACH ROW EXECUTE FUNCTION app.enforce_client_details_kind('individual');

CREATE TRIGGER client_organisations_kind
  BEFORE INSERT ON app.client_organisations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_client_details_kind('organisation');

-- And at least one: checked when the transaction commits, so the client and
-- its details are inserted together or not at all.
CREATE FUNCTION app.enforce_client_has_details() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.client_individuals WHERE client_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM app.client_organisations WHERE client_id = NEW.id) THEN
    RAISE EXCEPTION 'client % has no details', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER clients_have_details
  AFTER INSERT ON app.clients
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_client_has_details();
