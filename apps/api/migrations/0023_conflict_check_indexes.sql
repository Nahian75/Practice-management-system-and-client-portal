-- Review M1: a conflict check compared every stored name in full, calling
-- the normalising function on each row, so no index could help. A 20-name
-- check took 5.5 seconds against about 10,000 individuals, close to the
-- 15-second statement timeout. Trigram indexes on the normalised names, and
-- a query that uses them, keep each check to the names that can match.

CREATE INDEX client_individuals_name_trgm ON app.client_individuals
  USING gin (app.normalise_name(given_names || ' ' || family_name) extensions.gin_trgm_ops);
CREATE INDEX client_organisations_name_trgm ON app.client_organisations
  USING gin (app.normalise_name(legal_name) extensions.gin_trgm_ops);
CREATE INDEX client_contacts_name_trgm ON app.client_contacts
  USING gin (app.normalise_name(given_names || ' ' || family_name) extensions.gin_trgm_ops);
CREATE INDEX matter_parties_name_trgm ON app.matter_parties
  USING gin (app.normalise_name(name) extensions.gin_trgm_ops);

-- The same rule as before (app.name_likeness of 0.3 or more), worked out
-- only for candidates the indexes find: whole-name similarity of 0.1 or more,
-- or the checked name 0.8 inside the stored one ("Acme" in "Acme Trading").
-- The index cannot serve the other direction, a short stored name inside a
-- long checked one; such a name is still found when it is at least about a
-- tenth of the checked name (measured: "Acme" inside "Acme Trading
-- International Holdings" scores 0.14).
CREATE OR REPLACE FUNCTION app.find_possible_conflicts(checked_names text[], for_client uuid) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, pg_temp
  SET pg_trgm.similarity_threshold = 0.1
  SET pg_trgm.word_similarity_threshold = 0.8
  BEGIN ATOMIC
    WITH wanted AS (
      SELECT DISTINCT checked, app.normalise_name(checked) AS normalised FROM unnest(checked_names) AS checked
    ),
    candidates AS (
      SELECT w.checked, w.normalised, k.name, k.normalised_name, k.relation, k.client_id, k.matter_id
      FROM wanted w
      CROSS JOIN LATERAL (
        SELECT i.given_names || ' ' || i.family_name AS name,
               app.normalise_name(i.given_names || ' ' || i.family_name) AS normalised_name,
               'client' AS relation, i.client_id, NULL::uuid AS matter_id
          FROM app.client_individuals i
         WHERE app.normalise_name(i.given_names || ' ' || i.family_name) OPERATOR(extensions.%) w.normalised
            OR app.normalise_name(i.given_names || ' ' || i.family_name) OPERATOR(extensions.%>) w.normalised
        UNION ALL
        SELECT o.legal_name, app.normalise_name(o.legal_name), 'client', o.client_id, NULL
          FROM app.client_organisations o
         WHERE app.normalise_name(o.legal_name) OPERATOR(extensions.%) w.normalised
            OR app.normalise_name(o.legal_name) OPERATOR(extensions.%>) w.normalised
        UNION ALL
        SELECT c.given_names || ' ' || c.family_name, app.normalise_name(c.given_names || ' ' || c.family_name),
               'contact', c.client_id, NULL
          FROM app.client_contacts c
         WHERE app.normalise_name(c.given_names || ' ' || c.family_name) OPERATOR(extensions.%) w.normalised
            OR app.normalise_name(c.given_names || ' ' || c.family_name) OPERATOR(extensions.%>) w.normalised
        UNION ALL
        SELECT p.name, app.normalise_name(p.name), CASE p.role WHEN 'other' THEN 'other_party' ELSE p.role END,
               m.client_id, m.id
          FROM app.matter_parties p JOIN app.matters m ON m.id = p.matter_id
         WHERE app.normalise_name(p.name) OPERATOR(extensions.%) w.normalised
            OR app.normalise_name(p.name) OPERATOR(extensions.%>) w.normalised
      ) k
      WHERE NOT (k.client_id = for_client AND k.relation IN ('client', 'contact'))
    ),
    possible AS (
      SELECT checked, name, relation, client_id, matter_id, app.name_likeness(normalised, normalised_name) AS score
      FROM candidates
      WHERE app.name_likeness(normalised, normalised_name) >= 0.3
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
