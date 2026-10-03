import { randomBytes } from 'node:crypto';
import type { Env } from '../src/config/env.js';

// Fresh for every test process: secrets sealed in one run are never readable in another.
const TEST_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');

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
    TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY,
    APP_BASE_URL: 'http://localhost:3000',
    SMTP_URL: process.env['TEST_SMTP_URL'] ?? 'smtp://127.0.0.1:1025',
    MAIL_FROM_ADDRESS: 'no-reply@practice.test',
    MAIL_FROM_NAME: 'Practice Portal',
    ...overrides,
  };
}
