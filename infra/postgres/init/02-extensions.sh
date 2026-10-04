#!/bin/sh
set -eu

# Runs once, when the data volume is first created. For a database created
# before this file existed, run the same SQL once as the superuser:
#   docker compose exec -T postgres sh /docker-entrypoint-initdb.d/02-extensions.sh
#
# Extensions need the superuser, which the migration role deliberately is not.
# They live in their own schema, owned by the superuser and writable by nobody
# else, so no role can place a look-alike function ahead of them on the
# search path.
for database in pms pms_test; do
  psql --username=postgres --dbname="$database" --set=ON_ERROR_STOP=1 <<'SQL'

CREATE SCHEMA IF NOT EXISTS extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO pms_owner, pms_app;

-- Trigram matching, for conflict checks and name search.
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;
-- Accent removal, so Zoë and Zoe are the same name.
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;

SQL
done

psql --username=postgres --dbname=pms --set=ON_ERROR_STOP=1 <<'SQL'
ALTER ROLE pms_owner SET search_path = app, extensions;
ALTER ROLE pms_app SET search_path = app, extensions;
SQL
