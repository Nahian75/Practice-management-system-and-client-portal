import { randomBytes } from 'node:crypto';
import type { Env } from '../src/config/env.js';

// Fresh for every test process: secrets sealed in one run are never readable in another.
const TEST_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const TEST_DOCUMENT_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const TEST_FINANCE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
// Every Vitest worker can claim the same durable queue, just as several API
// instances can. They therefore need the same test-only key.
const TEST_MAIL_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
// Firm-wide Compliance lists (such as active holds) decrypt rows that other test
// workers and earlier runs created, so the AML key is shared in the same way.
const TEST_AML_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');
const TEST_SUSPICION_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
const TEST_HR_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');

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
    MAIL_ENCRYPTION_KEY: TEST_MAIL_ENCRYPTION_KEY,
    FINANCE_ENCRYPTION_KEY: TEST_FINANCE_ENCRYPTION_KEY,
    AML_ENCRYPTION_KEY: TEST_AML_ENCRYPTION_KEY,
    SUSPICION_ENCRYPTION_KEY: TEST_SUSPICION_ENCRYPTION_KEY,
    HR_ENCRYPTION_KEY: TEST_HR_ENCRYPTION_KEY,
    // Requests from supertest arrive over loopback; believing their X-Forwarded-For
    // lets each test choose the address it is rate-limited under.
    TRUSTED_PROXIES: ['loopback'],
    DOCUMENTS_S3_ENDPOINT: 'http://127.0.0.1:8333',
    DOCUMENTS_S3_REGION: 'eu-west-2',
    DOCUMENTS_S3_BUCKET: 'pms-documents-test',
    DOCUMENTS_S3_ACCESS_KEY: required('DOCUMENTS_S3_ACCESS_KEY'),
    DOCUMENTS_S3_SECRET_KEY: required('DOCUMENTS_S3_SECRET_KEY'),
    DOCUMENT_ENCRYPTION_KEY: TEST_DOCUMENT_ENCRYPTION_KEY,
    CLAMAV_HOST: '127.0.0.1',
    CLAMAV_PORT: 3310,
    ...overrides,
  };
}
