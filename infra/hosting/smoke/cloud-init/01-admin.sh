#!/bin/sh
set -eu
# Disposable local cloud simulation only. The provider administrator is deliberately not a superuser.
psql -U postgres -d pms -v ON_ERROR_STOP=1 -v password="$POSTGRES_PASSWORD" <<'SQL'
CREATE ROLE cloud_admin LOGIN CREATEROLE CREATEDB PASSWORD :'password';
ALTER DATABASE pms OWNER TO cloud_admin;
SQL
