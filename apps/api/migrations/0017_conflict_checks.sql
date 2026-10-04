-- Conflict checks and the other parties to a matter (docs/matters.md, step 8b).

-- pg_trgm and unaccent are installed by the superuser into the extensions
-- schema (infra/postgres/init/02-extensions.sh). Stop here with a clear
-- message if that step was missed.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent')) < 2 THEN
    RAISE EXCEPTION 'pg_trgm and unaccent are missing: run infra/postgres/init/02-extensions.sh as the superuser';
  END IF;
END;
$$;

-- The form names are compared in: no accents, lower case, apostrophes
-- dropped, other punctuation as spaces, and legal-form words (Ltd, Limited,
-- plc, and ...) left out, since thousands of names share them. "Zoë
-- O'Brien-Smith" and "zoe obrien smith" compare as the same, and so do "Smith
-- & Sons Ltd" and "Smith and Sons Limited". unaccent is called with its
-- dictionary named, which makes the function safe to mark immutable.
CREATE FUNCTION app.normalise_name(name text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(extensions.unaccent('extensions.unaccent'::regdictionary, name)), '[''’]', '', 'g'),
        '[^[:alnum:]]+', ' ', 'g'
      ),
      '\m(ltd|limited|plc|llp|lp|llc|inc|co|company|the|and)\M', '', 'g'
    ),
    ' +', ' ', 'g'
  ));

-- How alike two names are, from 0 to 1. Whole-name trigram similarity finds
-- spelling variants ("Jon Smyth" and "John Smith" score 0.31, measured); one
-- name inside the other counts only when it is nearly all there (0.8 or
-- more), so "Acme" finds "Acme Trading Ltd" but one shared word such as
-- "Holdings" does not make two companies alike.
CREATE FUNCTION app.name_likeness(a text, b text) RETURNS numeric
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  BEGIN ATOMIC
    SELECT round(greatest(
      extensions.similarity(a, b),
      CASE WHEN extensions.word_similarity(a, b) >= 0.8 THEN extensions.word_similarity(a, b) ELSE 0 END,
      CASE WHEN extensions.word_similarity(b, a) >= 0.8 THEN extensions.word_similarity(b, a) ELSE 0 END
    )::numeric, 2);
  END;

GRANT EXECUTE ON FUNCTION app.normalise_name(text), app.name_likeness(text, text) TO pms_app;


-- The other parties to a matter.
CREATE TABLE app.matter_parties (
  id        uuid        PRIMARY KEY DEFAULT uuidv7(),
  matter_id uuid        NOT NULL REFERENCES app.matters (id),
  role      text        NOT NULL,
  kind      text        NOT NULL,
  name      text        NOT NULL,
  added_by  uuid        NOT NULL REFERENCES app.accounts (id),
  added_at  timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT matter_parties_role_valid CHECK (role IN ('opponent', 'opponent_solicitor', 'other')),
  CONSTRAINT matter_parties_kind_valid CHECK (kind IN ('individual', 'organisation')),
  CONSTRAINT matter_parties_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT matter_parties_name_safe CHECK (app.is_safe_text(name))
);

CREATE INDEX matter_parties_matter_idx ON app.matter_parties (matter_id);

REVOKE INSERT ON app.matter_parties FROM pms_app;
GRANT INSERT (matter_id, role, kind, name, added_by) ON app.matter_parties TO pms_app;

-- Every name a conflict check compares against, with how it relates to the
-- firm: clients, contacts of clients, and the other parties on every matter.
-- A likeness of 0.3 or more is a possible match. A client's own record and
-- contacts are not a conflict with that client.
-- Returns the number of possible matches and the 50 strongest: a common name
-- can match thousands of records, and the strongest are what a partner reads.
-- Every name is compared in full each time; that is fast enough for a firm's
-- records, and an index can be added if it is not.
CREATE FUNCTION app.find_possible_conflicts(checked_names text[], for_client uuid) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  BEGIN ATOMIC
    WITH wanted AS (
      SELECT DISTINCT checked, app.normalise_name(checked) AS normalised FROM unnest(checked_names) AS checked
    ),
    known AS (
      SELECT i.given_names || ' ' || i.family_name AS name, 'client' AS relation, i.client_id, NULL::uuid AS matter_id
        FROM app.client_individuals i
      UNION ALL
      SELECT o.legal_name, 'client', o.client_id, NULL FROM app.client_organisations o
      UNION ALL
      SELECT c.given_names || ' ' || c.family_name, 'contact', c.client_id, NULL FROM app.client_contacts c
      UNION ALL
      SELECT p.name, CASE p.role WHEN 'other' THEN 'other_party' ELSE p.role END, m.client_id, m.id
        FROM app.matter_parties p JOIN app.matters m ON m.id = p.matter_id
    ),
    found AS (
      SELECT w.checked, k.name, k.relation, k.client_id, k.matter_id,
        app.name_likeness(w.normalised, app.normalise_name(k.name)) AS score
      FROM wanted w CROSS JOIN known k
      WHERE NOT (k.client_id = for_client AND k.relation IN ('client', 'contact'))
    ),
    possible AS (
      SELECT * FROM found WHERE score >= 0.3
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM possible),
      'matches', coalesce(
        (SELECT jsonb_agg(
           jsonb_build_object(
             'checkedName', checked, 'matchedName', name, 'relation', relation,
             'clientId', client_id, 'matterId', matter_id, 'score', score
           )
           ORDER BY score DESC, name
         )
         FROM (SELECT * FROM possible ORDER BY score DESC, name LIMIT 50) AS strongest),
        '[]'::jsonb
      )
    );
  END;

GRANT EXECUTE ON FUNCTION app.find_possible_conflicts(text[], uuid) TO pms_app;

-- A conflict check: the names checked for a client and every possible match,
-- written once and never changed. The app gives the client and the names;
-- the database adds the client's own name (is the new client someone's
-- opponent?) and finds the matches itself, so no app bug can record a check
-- as clear when it is not. The names stay here, out of the audit log.
CREATE TABLE app.conflict_checks (
  id           uuid        PRIMARY KEY DEFAULT uuidv7(),
  client_id    uuid        NOT NULL REFERENCES app.clients (id),
  requested_by uuid        NOT NULL REFERENCES app.accounts (id),
  names        text[]      NOT NULL,
  matches      jsonb       NOT NULL DEFAULT '[]',
  match_count  integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT conflict_checks_names_count CHECK (cardinality(names) BETWEEN 1 AND 21),
  CONSTRAINT conflict_checks_matches_array CHECK (jsonb_typeof(matches) = 'array'),
  CONSTRAINT conflict_checks_match_count CHECK (match_count >= jsonb_array_length(matches))
);

REVOKE INSERT ON app.conflict_checks FROM pms_app;
GRANT INSERT (client_id, requested_by, names) ON app.conflict_checks TO pms_app;

CREATE FUNCTION app.run_conflict_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
  client_name text := (
    SELECT coalesce(o.legal_name, i.given_names || ' ' || i.family_name)
    FROM app.clients c
    LEFT JOIN app.client_individuals i ON i.client_id = c.id
    LEFT JOIN app.client_organisations o ON o.client_id = c.id
    WHERE c.id = NEW.client_id
  );
BEGIN
  IF NOT app.normalise_name(client_name) = ANY (SELECT app.normalise_name(name) FROM unnest(NEW.names) AS name) THEN
    NEW.names := client_name || NEW.names;
  END IF;
  result := app.find_possible_conflicts(NEW.names, NEW.client_id);
  NEW.matches := result -> 'matches';
  NEW.match_count := (result ->> 'total')::integer;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conflict_checks_run
  BEFORE INSERT ON app.conflict_checks
  FOR EACH ROW EXECUTE FUNCTION app.run_conflict_check();

-- Each new matter names the conflict check it was opened on, once. Rows
-- opened before checks existed (in development only) are left alone:
-- NOT VALID makes the rule apply to every row inserted from now on.
ALTER TABLE app.matters ADD COLUMN conflict_check_id uuid REFERENCES app.conflict_checks (id);
ALTER TABLE app.matters ADD CONSTRAINT matters_conflict_check_required CHECK (conflict_check_id IS NOT NULL) NOT VALID;
CREATE UNIQUE INDEX matters_conflict_check_key ON app.matters (conflict_check_id);
GRANT INSERT (conflict_check_id) ON app.matters TO pms_app;

-- The check must be for this client, by the person opening the matter, and
-- less than a day old. The matter starts as awaiting_clearance when the check
-- found any possible match.
CREATE FUNCTION app.apply_conflict_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  found_matches integer := (
    SELECT match_count FROM app.conflict_checks
    WHERE id = NEW.conflict_check_id
      AND client_id = NEW.client_id
      AND requested_by = NEW.opened_by
      AND created_at > clock_timestamp() - interval '24 hours'
  );
BEGIN
  IF found_matches IS NULL THEN
    RAISE EXCEPTION 'a matter needs a conflict check for its client, by its opener, from the last 24 hours'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.status := CASE WHEN found_matches > 0 THEN 'awaiting_clearance' ELSE 'open' END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matters_conflict_check
  BEFORE INSERT ON app.matters
  FOR EACH ROW EXECUTE FUNCTION app.apply_conflict_check();

-- Every party was in the matter's conflict check: nobody can be added to a
-- matter without having been checked.
CREATE FUNCTION app.enforce_party_was_checked() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.matters m
    JOIN app.conflict_checks c ON c.id = m.conflict_check_id
    WHERE m.id = NEW.matter_id
      AND app.normalise_name(NEW.name) IN (SELECT app.normalise_name(checked) FROM unnest(c.names) AS checked)
  ) THEN
    -- The name is left out of the message: database errors reach the logs.
    RAISE EXCEPTION 'a party was not in the matter''s conflict check'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matter_parties_checked
  BEFORE INSERT ON app.matter_parties
  FOR EACH ROW EXECUTE FUNCTION app.enforce_party_was_checked();
