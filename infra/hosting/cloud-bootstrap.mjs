import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { cloudConfig } from './cloud-config.mjs';
import { loadEnv } from '../../apps/api/dist/config/env.js';

async function bootstrap() {
  const config = cloudConfig(process.env);
  loadEnv(config.runtime);
  const db = new pg.Client({ connectionString: config.adminUrl });
  const quote = pg.escapeIdentifier;
  const literal = pg.escapeLiteral;
  const fingerprint = createHash('sha256').update(process.env.CLOUD_ROOT_KEY).digest('hex');
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('stass-cloud-bootstrap-v1'))");
    const { rows: [identity] } = await db.query(`SELECT current_user AS administrator, current_database() AS database,
      current_setting('server_version_num')::int AS version, to_regclass('migrations.hosting_identity') AS marker,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='app') AS app_exists`);
    if (identity.version < 180000) throw new Error('PostgreSQL 18 or later is required.');
    if (['pms_app', 'pms_owner'].includes(identity.administrator)) throw new Error('Bootstrap requires the provider administrator.');
    if (identity.marker) {
      const { rows: [saved] } = await db.query('SELECT fingerprint FROM migrations.hosting_identity WHERE singleton=true');
      if (saved?.fingerprint !== fingerprint) throw new Error('Deployment root secret changed. Restore the original CLOUD_ROOT_KEY.');
    } else if (identity.app_exists) {
      throw new Error('This database already has an app schema. Use a fresh database or a reviewed migration procedure.');
    }
    for (const role of ['pms_owner', 'pms_app']) {
      const { rows } = await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=$1', [role]);
      if (!rows.length) {
        const password = decodeURIComponent(new URL(role === 'pms_app' ? config.runtime.DATABASE_URL : config.migrationUrl).password);
        await db.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      } else if (!identity.marker || Object.values(rows[0]).some(Boolean)) {
        throw new Error('Existing database role is unsafe or belongs to another deployment.');
      }
    }
    await db.query(`GRANT pms_owner TO ${quote(identity.administrator)} WITH INHERIT TRUE, SET TRUE`);
    await db.query(`REVOKE ALL ON DATABASE ${quote(identity.database)} FROM PUBLIC`);
    await db.query(`GRANT CONNECT ON DATABASE ${quote(identity.database)} TO pms_owner,pms_app`);
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await db.query('CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION pms_owner');
    await db.query('CREATE SCHEMA IF NOT EXISTS migrations AUTHORIZATION pms_owner');
    await db.query('CREATE SCHEMA IF NOT EXISTS extensions');
    await db.query('REVOKE ALL ON SCHEMA extensions FROM PUBLIC');
    await db.query('GRANT USAGE ON SCHEMA extensions TO pms_owner,pms_app');
    await db.query('GRANT USAGE ON SCHEMA app TO pms_app');
    for (const extension of ['pg_trgm', 'unaccent']) {
      const { rows } = await db.query(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=$1`, [extension]);
      if (!rows.length) await db.query(`CREATE EXTENSION ${quote(extension)} SCHEMA extensions`);
      else if (rows[0].nspname !== 'extensions') throw new Error('Extension exists in an unexpected schema. Use a fresh database.');
    }
    await db.query('ALTER ROLE pms_owner SET search_path=app,extensions');
    await db.query('ALTER ROLE pms_app SET search_path=app,extensions');
    await db.query("ALTER ROLE pms_app SET statement_timeout='15s'");
    await db.query("ALTER ROLE pms_app SET idle_in_transaction_session_timeout='30s'");
    await db.query('ALTER ROLE pms_app CONNECTION LIMIT 50');
    await db.query('ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app GRANT SELECT,INSERT ON TABLES TO pms_app');
    await db.query('ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner IN SCHEMA app GRANT USAGE ON SEQUENCES TO pms_app');
    await db.query('ALTER DEFAULT PRIVILEGES FOR ROLE pms_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    await db.query(`CREATE TABLE IF NOT EXISTS migrations.hosting_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL)`);
    await db.query('INSERT INTO migrations.hosting_identity (singleton,fingerprint) VALUES(true,$1) ON CONFLICT DO NOTHING', [fingerprint]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await db.end(); }
  const migration = spawnSync(process.execPath, ['--enable-source-maps', 'dist/database/migrate.js'], {
    env: { ...config.runtime, MIGRATION_DATABASE_URL: config.migrationUrl }, stdio: 'inherit',
  });
  if (migration.status !== 0) throw new Error('Database migration failed.');
  const app = new pg.Client({ connectionString: config.runtime.DATABASE_URL });
  let needsInvitation;
  try {
    await app.connect();
    needsInvitation = !(await app.query("SELECT EXISTS(SELECT 1 FROM app.accounts WHERE kind='staff') AS ready")).rows[0].ready;
  } finally { await app.end(); }
  if (needsInvitation) {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_NAME) throw new Error('First administrator details are missing.');
    const invitation = spawnSync(process.execPath, ['dist/cli/invite.js', '--kind', 'staff', '--email', process.env.ADMIN_EMAIL,
      '--name', process.env.ADMIN_NAME, '--role', 'administrator', '--role', 'partner', '--role', 'compliance'],
    { env: config.runtime, stdio: 'inherit' });
    if (invitation.status !== 0) throw new Error('Administrator invitation failed.');
  } else console.log('Existing staff accounts preserved.');
}

try { await bootstrap(); }
catch (error) {
  // PostgreSQL/provider errors may contain connection settings; do not print arbitrary error objects.
  const safe = ['PostgreSQL 18 or later is required.', 'Deployment root secret changed. Restore the original CLOUD_ROOT_KEY.',
    'This database already has an app schema. Use a fresh database or a reviewed migration procedure.',
    'Existing database role is unsafe or belongs to another deployment.', 'Extension exists in an unexpected schema. Use a fresh database.',
    'Database migration failed.', 'Administrator invitation failed.', 'First administrator details are missing.'];
  console.error(safe.includes(error.message) ? error.message : 'Cloud bootstrap failed. Verify database permissions, verified TLS and required environment settings.');
  process.exitCode = 1;
}
