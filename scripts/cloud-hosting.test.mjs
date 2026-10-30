import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfig } from '../infra/hosting/cloud-config.mjs';

const source = { CLOUD_ROOT_KEY: 'a'.repeat(64), CLOUD_ADMIN_DATABASE_URL: 'postgresql://provider:secret@db.example.test/pms?sslmode=disable',
  CLOUD_APP_BASE_URL: 'https://practice.example.test', MIGRATION_DATABASE_URL: 'should-not-reach-api', CLOUD_OTHER_SECRET: 'private' };

test('managed runtime uses a restricted role, verified TLS, stable domain-separated keys and no bootstrap credentials', () => {
  const first = cloudConfig(source), second = cloudConfig(source);
  assert.deepEqual(first, second);
  const app = new URL(first.runtime.DATABASE_URL), owner = new URL(first.migrationUrl);
  assert.equal(app.username, 'pms_app'); assert.equal(owner.username, 'pms_owner');
  assert.notEqual(app.password, owner.password);
  assert.equal(app.searchParams.get('sslmode'), 'verify-full');
  assert.equal(new URL(first.adminUrl).searchParams.get('sslmode'), 'verify-full');
  assert.equal(Object.keys(first.runtime).some(key => key.startsWith('CLOUD_')), false);
  assert.equal(first.runtime.MIGRATION_DATABASE_URL, undefined);
  assert.equal(JSON.stringify(first.runtime).includes('provider:'), false);
  const keys = Object.entries(first.runtime).filter(([key]) => key.endsWith('_ENCRYPTION_KEY')).map(([, value]) => value);
  assert.equal(keys.length, 7); assert.equal(new Set(keys).size, 7);
  for (const key of keys) assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(cloudConfig({ ...source, CLOUD_APP_BASE_URL: 'https://changed.example.test' }).runtime.TOTP_ENCRYPTION_KEY, first.runtime.TOTP_ENCRYPTION_KEY);
  assert.notEqual(cloudConfig({ ...source, CLOUD_ROOT_KEY: 'b'.repeat(64) }).runtime.TOTP_ENCRYPTION_KEY, first.runtime.TOTP_ENCRYPTION_KEY);
});

test('managed runtime rejects weak root keys and insecure or path-bearing website URLs', () => {
  assert.throws(() => cloudConfig({ ...source, CLOUD_ROOT_KEY: 'short' }));
  for (const url of ['http://practice.test', 'https://practice.test/path', 'https://user:pass@practice.test']) {
    assert.throws(() => cloudConfig({ ...source, CLOUD_APP_BASE_URL: url }));
  }
});

test('key rotation retains old ciphertext keys without changing database credentials', () => {
  const original=cloudConfig(source).runtime;
  const rotated=cloudConfig({...source,ENCRYPTION_KEY_VERSION:'3'}).runtime;
  const previous=JSON.parse(rotated.PREVIOUS_ENCRYPTION_KEYS);
  assert.equal(rotated.DATABASE_URL,original.DATABASE_URL);
  for(const purpose of ['TOTP','MAIL','FINANCE','AML','SUSPICION','HR','DOCUMENT']){
    assert.equal(previous[purpose]['1'],original[`${purpose}_ENCRYPTION_KEY`]);
    assert.notEqual(rotated[`${purpose}_ENCRYPTION_KEY`],previous[purpose]['1']);
    assert.notEqual(previous[purpose]['2'],previous[purpose]['1']);
  }
  assert.throws(()=>cloudConfig({...source,ENCRYPTION_KEY_VERSION:'65'}));
});
