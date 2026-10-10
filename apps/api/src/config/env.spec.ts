import { describe, expect, it } from 'vitest';
import { InvalidEnvError, loadEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://pms_app:local-password@127.0.0.1:5432/pms';
const PRODUCTION_DATABASE_URL = 'postgres://pms_app:prod-password@db.internal:5432/pms';

const TOTP_KEY = Buffer.alloc(32, 7).toString('base64');
const MAIL_KEY = Buffer.alloc(32, 8).toString('base64');
const FINANCE_KEY = Buffer.alloc(32, 10).toString('base64');
const AML_KEY = Buffer.alloc(32, 12).toString('base64');
const MAIL = {
  APP_BASE_URL: 'http://localhost:3000',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  MAIL_FROM_ADDRESS: 'no-reply@example.com',
  MAIL_ENCRYPTION_KEY: MAIL_KEY,
};
const DOCUMENT_KEY = Buffer.alloc(32, 9).toString('base64');
const DOCUMENTS = {
  DOCUMENTS_S3_ENDPOINT: 'http://127.0.0.1:8333',
  DOCUMENTS_S3_BUCKET: 'pms-documents',
  DOCUMENTS_S3_ACCESS_KEY: 'local-access-key',
  DOCUMENTS_S3_SECRET_KEY: 'local-secret-key-0123',
  DOCUMENT_ENCRYPTION_KEY: DOCUMENT_KEY,
};
const minimal = {
  NODE_ENV: 'development', DATABASE_URL: LOCAL_DATABASE_URL,
  TOTP_ENCRYPTION_KEY: TOTP_KEY, FINANCE_ENCRYPTION_KEY: FINANCE_KEY, AML_ENCRYPTION_KEY: AML_KEY,
  ...MAIL, ...DOCUMENTS,
};

describe('loadEnv', () => {
  it('applies safe defaults for optional settings', () => {
    expect(loadEnv(minimal)).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'log',
      DATABASE_URL: LOCAL_DATABASE_URL,
      TOTP_ENCRYPTION_KEY: TOTP_KEY,
      ...MAIL,
      FINANCE_ENCRYPTION_KEY: FINANCE_KEY,
      AML_ENCRYPTION_KEY: AML_KEY,
      MAIL_FROM_NAME: 'Practice Portal',
      TRUSTED_PROXIES: [],
      ...DOCUMENTS,
      DOCUMENTS_S3_REGION: 'eu-west-2',
      CLAMAV_HOST: '127.0.0.1',
      CLAMAV_PORT: 3310,
    });
  });

  it('converts PORT from text to a number', () => {
    expect(loadEnv({ ...minimal, PORT: '8080' }).PORT).toBe(8080);
  });

  it('ignores unrelated environment variables', () => {
    const env = loadEnv({ ...minimal, PATH: '/usr/bin', MIGRATION_DATABASE_URL: LOCAL_DATABASE_URL });

    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('MIGRATION_DATABASE_URL');
  });

  it.each([
    'NODE_ENV',
    'DATABASE_URL',
    'TOTP_ENCRYPTION_KEY',
    'APP_BASE_URL',
    'SMTP_URL',
    'MAIL_FROM_ADDRESS',
    'MAIL_ENCRYPTION_KEY',
    'FINANCE_ENCRYPTION_KEY',
    'AML_ENCRYPTION_KEY',
    'DOCUMENTS_S3_ENDPOINT',
    'DOCUMENTS_S3_BUCKET',
    'DOCUMENTS_S3_ACCESS_KEY',
    'DOCUMENTS_S3_SECRET_KEY',
    'DOCUMENT_ENCRYPTION_KEY',
  ])('refuses to start without %s', (name) => {
    const source: Record<string, string> = { ...minimal };
    delete source[name];

    expect(() => loadEnv(source)).toThrow(InvalidEnvError);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '30.5'],
    ['LOG_LEVEL', 'everything'],
    ['HOST', ''],
    ['DATABASE_URL', 'not a url'],
    ['DATABASE_URL', 'mysql://user:pass@host/db'],
    ['DATABASE_URL', 'https://example.com'],
    ['TOTP_ENCRYPTION_KEY', 'not base64!'],
    ['TOTP_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64')],
    ['TOTP_ENCRYPTION_KEY', Buffer.alloc(64).toString('base64')],
    ['APP_BASE_URL', 'javascript:alert(1)'],
    ['APP_BASE_URL', 'ftp://example.com'],
    ['SMTP_URL', 'http://mail.example.com'],
    ['MAIL_FROM_ADDRESS', 'not-an-email'],
    ['MAIL_FROM_NAME', ''],
    ['MAIL_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64')],
    ['FINANCE_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64')],
    ['AML_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64')],
    ['TRUSTED_PROXIES', '*'],
    ['TRUSTED_PROXIES', 'true'],
    ['TRUSTED_PROXIES', 'proxy.example.com'],
    ['TRUSTED_PROXIES', '10.0.0.0/33'],
    ['TRUSTED_PROXIES', '10.0.0.0/8/1'],
    ['DOCUMENTS_S3_ENDPOINT', 'ftp://storage.example.com'],
    ['DOCUMENTS_S3_BUCKET', 'Documents'],
    ['DOCUMENTS_S3_BUCKET', '../other-bucket'],
    ['DOCUMENTS_S3_SECRET_KEY', 'short'],
    ['DOCUMENT_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64')],
    ['CLAMAV_PORT', '0'],
  ])('rejects %s=%j', (name, value) => {
    expect(() => loadEnv({ ...minimal, [name]: value })).toThrow(InvalidEnvError);
  });

  it.each([
    ['10.0.0.5', ['10.0.0.5']],
    ['10.0.0.0/8, 192.168.1.10', ['10.0.0.0/8', '192.168.1.10']],
    ['loopback,uniquelocal', ['loopback', 'uniquelocal']],
    ['2001:db8::/32', ['2001:db8::/32']],
  ])('accepts TRUSTED_PROXIES=%j', (value, expected) => {
    expect(loadEnv({ ...minimal, TRUSTED_PROXIES: value }).TRUSTED_PROXIES).toEqual(expected);
  });

  it('names the broken variable without echoing its value', () => {
    const secretLookingValue = 'sk-live-should-never-be-printed';

    expect(() => loadEnv({ ...minimal, PORT: secretLookingValue })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secretLookingValue) }),
    );
    expect(() => loadEnv({ ...minimal, PORT: secretLookingValue })).toThrow(/PORT/);
  });

  it('requires a distinct AML encryption key',()=>{
    expect(()=>loadEnv({...minimal,AML_ENCRYPTION_KEY:DOCUMENT_KEY})).toThrow(/AML_ENCRYPTION_KEY: must be separate from DOCUMENT_ENCRYPTION_KEY/);
  });

  describe('in production', () => {
    const production = {
      NODE_ENV: 'production',
      TOTP_ENCRYPTION_KEY: TOTP_KEY,
      FINANCE_ENCRYPTION_KEY: FINANCE_KEY,
      AML_ENCRYPTION_KEY: AML_KEY,
      ...MAIL,
      APP_BASE_URL: 'https://portal.example.com',
      ...DOCUMENTS,
      DOCUMENTS_S3_ENDPOINT: 'https://storage.example.com',
    };

    it('requires the database connection to verify the server certificate', () => {
      expect(() => loadEnv({ ...production, DATABASE_URL: PRODUCTION_DATABASE_URL })).toThrow(
        /DATABASE_URL: must set sslmode=verify-full/,
      );
    });

    it.each(['disable', 'prefer', 'require', 'verify-ca'])('rejects sslmode=%s', (sslmode) => {
      expect(() =>
        loadEnv({ ...production, DATABASE_URL: `${PRODUCTION_DATABASE_URL}?sslmode=${sslmode}` }),
      ).toThrow(InvalidEnvError);
    });

    it('accepts sslmode=verify-full', () => {
      const env = loadEnv({ ...production, DATABASE_URL: `${PRODUCTION_DATABASE_URL}?sslmode=verify-full` });

      expect(env.NODE_ENV).toBe('production');
    });

    it('requires links in emails to use https', () => {
      expect(() =>
        loadEnv({ ...production, DATABASE_URL: `${PRODUCTION_DATABASE_URL}?sslmode=verify-full`, APP_BASE_URL: 'http://portal.example.com' }),
      ).toThrow(/APP_BASE_URL: must use https in production/);
    });

    it('requires document storage to be reached over https', () => {
      expect(() =>
        loadEnv({
          ...production,
          DATABASE_URL: `${PRODUCTION_DATABASE_URL}?sslmode=verify-full`,
          DOCUMENTS_S3_ENDPOINT: 'http://storage.example.com',
        }),
      ).toThrow(/DOCUMENTS_S3_ENDPOINT: must use https in production/);
    });

    it('does not print the database password when rejecting the URL', () => {
      expect(() => loadEnv({ ...production, DATABASE_URL: PRODUCTION_DATABASE_URL })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('prod-password') }),
      );
    });
  });
});
