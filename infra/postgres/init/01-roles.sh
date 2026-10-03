#!/bin/sh
set -eu

# Runs once, when the data volume is first created.
# Passwords are passed as psql variables so they are quoted by psql, never spliced into SQL.
psql --username=postgres --dbname=pms --set=ON_ERROR_STOP=1 \
  --set=owner_password="$PMS_OWNER_PASSWORD" \
  --set=app_password="$PMS_APP_PASSWORD" <<'SQL'

CREATE ROLE pms_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE pms_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  CONNECTION LIMIT 50;

ALTER ROLE pms_owner SET search_path = app;
ALTER ROLE pms_app SET search_path = app;
ALTER ROLE pms_app SET statement_timeout = '15s';
ALTER ROLE pms_app SET idle_in_transaction_session_timeout = '30s';

CREATE DATABASE pms_test;

SQL

for database in pms pms_test; do
  psql --username=postgres --dbname="$database" --set=ON_ERROR_STOP=1 \
    --set=database="$database" <<'SQL'

REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO pms_owner, pms_app;

CREATE SCHEMA app AUTHORIZATION pms_owner;
GRANT USAGE ON SCHEMA app TO pms_app;

-- Migration bookkeeping. The app role has no access, so it cannot fake an applied migration.
CREATE SCHEMA migrations AUTHORIZATION pms_owner;

-- New tables give the app read and insert only.
-- UPDATE and DELETE are granted table by table, in the migration that needs them.
ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app
  GRANT SELECT, INSERT ON TABLES TO pms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app
  GRANT USAGE ON SEQUENCES TO pms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

SQL
done

# Tests create throwaway schemas, so the owner may create schemas in the test database only.
psql --username=postgres --dbname=pms_test --set=ON_ERROR_STOP=1 \
  --command="GRANT CREATE ON DATABASE pms_test TO pms_owner;"
