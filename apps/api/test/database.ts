import type { Env } from '../src/config/env.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Integration tests need the local database (see docs/testing.md).`);
  }
  return value;
}

export const testAppDatabaseUrl = (): string => required('TEST_DATABASE_URL');
export const testOwnerDatabaseUrl = (): string => required('TEST_MIGRATION_DATABASE_URL');

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DATABASE_URL: testAppDatabaseUrl(),
    ...overrides,
  };
}
