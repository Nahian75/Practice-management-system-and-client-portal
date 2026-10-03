import { describe, expect, it } from 'vitest';
import { InvalidEnvError, loadEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://pms_app:local-password@127.0.0.1:5432/pms';
const PRODUCTION_DATABASE_URL = 'postgres://pms_app:prod-password@db.internal:5432/pms';

const TOTP_KEY = Buffer.alloc(32, 7).toString('base64');
const MAIL = { APP_BASE_URL: 'http://localhost:3000', SMTP_URL: 'smtp://127.0.0.1:1025', MAIL_FROM_ADDRESS: 'no-reply@example.com' };
const minimal = { NODE_ENV: 'development', DATABASE_URL: LOCAL_DATABASE_URL, TOTP_ENCRYPTION_KEY: TOTP_KEY, ...MAIL };

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
      MAIL_FROM_NAME: 'Practice Portal',
      TRUSTED_PROXIES: [],
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

  it.each(['NODE_ENV', 'DATABASE_URL', 'TOTP_ENCRYPTION_KEY', 'APP_BASE_URL', 'SMTP_URL', 'MAIL_FROM_ADDRESS'])('refuses to start without %s', (name) => {
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
    ['TRUSTED_PROXIES', '*'],
    ['TRUSTED_PROXIES', 'true'],
    ['TRUSTED_PROXIES', 'proxy.example.com'],
    ['TRUSTED_PROXIES', '10.0.0.0/33'],
    ['TRUSTED_PROXIES', '10.0.0.0/8/1'],
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

  describe('in production', () => {
    const production = { NODE_ENV: 'production', TOTP_ENCRYPTION_KEY: TOTP_KEY, ...MAIL, APP_BASE_URL: 'https://portal.example.com' };

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

    it('does not print the database password when rejecting the URL', () => {
      expect(() => loadEnv({ ...production, DATABASE_URL: PRODUCTION_DATABASE_URL })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('prod-password') }),
      );
    });
  });
});
