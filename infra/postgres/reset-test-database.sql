-- Recreates the local test database, pms_test, empty. The development
-- database, pms, is not touched. Run as the superuser from the repository root:
--   npm run db:reset-test
-- The next test run applies every migration again.
--
-- Tests leave their rows behind (the app role cannot delete), so the test
-- database grows with every run; that slows the suite and, for name matching,
-- makes near-matches between random test names more likely.
--
-- The setup below repeats what infra/postgres/init/01-roles.sh and
-- 02-extensions.sh do for pms_test. Keep them in step.

\set ON_ERROR_STOP on

DROP DATABASE IF EXISTS pms_test WITH (FORCE);
CREATE DATABASE pms_test;

\connect pms_test

REVOKE ALL ON DATABASE pms_test FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE pms_test TO pms_owner, pms_app;

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
GRANT CREATE ON DATABASE pms_test TO pms_owner;

CREATE SCHEMA extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions TO pms_owner, pms_app;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION unaccent SCHEMA extensions;
