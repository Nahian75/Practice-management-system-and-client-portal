import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Keep existing keys: replacing them would make stored encrypted records unreadable.
const root = fileURLToPath(new URL('../', import.meta.url));
const targets = ['.env', 'apps/api/.env', 'apps/web/.env.local'];
const existing = targets.filter((path) => existsSync(resolve(root, path)));
if (existing.length === targets.length) {
  console.log('Local configuration already exists. No credentials changed.');
  process.exit(0);
}
if (existing.length > 0) {
  console.error('Partial local configuration exists. Complete the missing files from their examples using the existing database and storage credentials. Existing secrets were not changed.');
  process.exit(1);
}

const secret = () => randomBytes(24).toString('base64url');
const values = {
  POSTGRES_PASSWORD: secret(), PMS_OWNER_PASSWORD: secret(), PMS_APP_PASSWORD: secret(),
  DOCUMENTS_S3_ACCESS_KEY: secret(), DOCUMENTS_S3_SECRET_KEY: secret(),
};
function fill(template, replacements) {
  return template.replace(/^(\w+)=(.*)$/gm, (line, key) => key in replacements ? `${key}=${replacements[key]}` : line);
}
const apiValues = {
  ...values,
  DATABASE_URL: `postgres://pms_app:${values.PMS_APP_PASSWORD}@127.0.0.1:5432/pms`,
  MIGRATION_DATABASE_URL: `postgres://pms_owner:${values.PMS_OWNER_PASSWORD}@127.0.0.1:5432/pms`,
  TEST_DATABASE_URL: `postgres://pms_app:${values.PMS_APP_PASSWORD}@127.0.0.1:5432/pms_test`,
  TEST_MIGRATION_DATABASE_URL: `postgres://pms_owner:${values.PMS_OWNER_PASSWORD}@127.0.0.1:5432/pms_test`,
};
for (const key of ['TOTP', 'MAIL', 'FINANCE', 'AML', 'SUSPICION', 'HR', 'DOCUMENT']) {
  apiValues[`${key}_ENCRYPTION_KEY`] = randomBytes(32).toString('base64');
}
const files = [
  fill(readFileSync(resolve(root, '.env.example'), 'utf8'), values),
  fill(readFileSync(resolve(root, 'apps/api/.env.example'), 'utf8'), apiValues),
  readFileSync(resolve(root, 'apps/web/.env.example'), 'utf8'),
];
for (const content of files) {
  if (Object.values(parseEnv(content)).some((value) => value === '' || value.includes('<password>'))) {
    throw new Error('An environment template still contains an unfilled value. No files were written.');
  }
}
targets.forEach((path, index) => writeFileSync(resolve(root, path), files[index], { flag: 'wx', mode: 0o600 }));
console.log('Created all three ignored local environment files with independent random secrets.');
console.log('Next: start Docker Desktop, then run start.bat.');
