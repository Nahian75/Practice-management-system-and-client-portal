import { describe, expect, it } from 'vitest';
import { InvalidEnvError, loadEnv } from './env.js';

const LOCAL_DATABASE_URL = 'postgres://pms_app:local-password@127.0.0.1:5432/pms';
const PRODUCTION_DATABASE_URL = 'postgres://pms_app:prod-password@db.internal:5432/pms';

const minimal = { NODE_ENV: 'development', DATABASE_URL: LOCAL_DATABASE_URL };

describe('loadEnv', () => {
  it('applies safe defaults for optional settings', () => {
    expect(loadEnv(minimal)).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'log',
      DATABASE_URL: LOCAL_DATABASE_URL,
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

  it.each(['NODE_ENV', 'DATABASE_URL'])('refuses to start without %s', (name) => {
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
  ])('rejects %s=%j', (name, value) => {
    expect(() => loadEnv({ ...minimal, [name]: value })).toThrow(InvalidEnvError);
  });

  it('names the broken variable without echoing its value', () => {
    const secretLookingValue = 'sk-live-should-never-be-printed';

    expect(() => loadEnv({ ...minimal, PORT: secretLookingValue })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secretLookingValue) }),
    );
    expect(() => loadEnv({ ...minimal, PORT: secretLookingValue })).toThrow(/PORT/);
  });

  describe('in production', () => {
    const production = { NODE_ENV: 'production' };

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

    it('does not print the database password when rejecting the URL', () => {
      expect(() => loadEnv({ ...production, DATABASE_URL: PRODUCTION_DATABASE_URL })).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('prod-password') }),
      );
    });
  });
});
