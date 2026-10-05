-- Recreates a local test database, empty: pms_test for the API's tests, or
-- pms_e2e for the web app's end-to-end tests, named by the variable `db`.
-- The development database, pms, is not touched. Run as the superuser from
-- the repository root:
--   npm run db:reset-test          (pms_test; its next run migrates it)
--   npm run test:e2e -w @practice/web   (resets and migrates pms_e2e first)
--
-- Tests leave their rows behind (the app role cannot delete), so the test
-- database grows with every run; that slows the suite and, for name matching,
-- makes near-matches between random test names more likely.
--
-- The setup below repeats what infra/postgres/init/01-roles.sh and
-- 02-extensions.sh do for the test database. Keep them in step.

\set ON_ERROR_STOP on
\if :{?db}
\else
  \echo 'Name the database: psql -v db=pms_test (or pms_e2e)'
  \quit
\endif

DROP DATABASE IF EXISTS :"db" WITH (FORCE);
CREATE DATABASE :"db";

\connect :db

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO pms_owner, pms_app;

CREATE SCHEMA app AUTHORIZATION pms_owner;
GRANT USAGE ON SCHEMA app TO pms_app;

CREATE SCHEMA migrations AUTHORIZATION pms_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app
  GRANT SELECT, INSERT ON TABLES TO pms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app
  GRANT USAGE ON SEQUENCES TO pms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Tests create throwaway schemas, so the owner may create schemas here.
GRANT CREATE ON DATABASE :"db" TO pms_owner;

CREATE SCHEMA extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO pms_owner, pms_app;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION unaccent SCHEMA extensions;
