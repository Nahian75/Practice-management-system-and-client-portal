-- Run with a database administrator, with a separately generated secret supplied
-- via psql variable audit_reader_password. Never grant this identity to the API.
\set ON_ERROR_STOP on
CREATE ROLE pms_audit_reader LOGIN PASSWORD :'audit_reader_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"DBNAME" TO pms_audit_reader;
GRANT USAGE ON SCHEMA app TO pms_audit_reader;
GRANT SELECT ON app.audit_events TO pms_audit_reader;
GRANT SELECT(record_kind,record_id) ON app.aml_disposed_records,app.hr_disposed_records TO pms_audit_reader;
ALTER ROLE pms_audit_reader SET default_transaction_read_only=on;
ALTER ROLE pms_audit_reader SET statement_timeout='15s';
