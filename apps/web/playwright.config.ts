import { defineConfig, devices } from '@playwright/test';
import { e2eDatabaseUrl } from './e2e/support/database.mjs';

// The API's local settings hold the test database and Mailpit addresses.
process.loadEnvFile('../api/.env');

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set in apps/api/.env`);
  }
  return value;
};

/** Their own ports, so the tests never meet the development servers. */
export const E2E_WEB_URL = 'http://localhost:3100';
/** The same web app with no API behind it, to show what people see when the API is down. */
export const E2E_NO_API_WEB_URL = 'http://localhost:3102';
const E2E_API_PORT = '3101';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: E2E_WEB_URL,
    // Traces and screenshots can show tokens; they stay in the git-ignored test-results/.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The built API, against the end-to-end database (e2e/prepare-database.mjs).
      command: 'node --enable-source-maps ../api/dist/main.js',
      url: `http://127.0.0.1:${E2E_API_PORT}/health`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: E2E_API_PORT,
        LOG_LEVEL: 'error',
        DATABASE_URL: e2eDatabaseUrl(required('TEST_DATABASE_URL')),
        TOTP_ENCRYPTION_KEY: required('TOTP_ENCRYPTION_KEY'),
        APP_BASE_URL: E2E_WEB_URL,
        SMTP_URL: required('SMTP_URL'),
        MAIL_FROM_ADDRESS: required('MAIL_FROM_ADDRESS'),
        MAIL_FROM_NAME: required('MAIL_FROM_NAME'),
        TRUSTED_PROXIES: 'loopback',
      },
    },
    {
      // The built web app, started exactly as in production (only its port differs).
      command: 'npm run start -- --port 3100',
      url: `${E2E_WEB_URL}/sign-in`,
      reuseExistingServer: false,
      env: { API_URL: `http://127.0.0.1:${E2E_API_PORT}`, APP_NAME: 'Stass' },
    },
    {
      // Nothing listens on 3109: every call to the API is refused, as when it is down.
      // Its pages need the API, so readiness is the port being open.
      command: 'npm run start -- --port 3102',
      port: 3102,
      reuseExistingServer: false,
      env: { API_URL: 'http://127.0.0.1:3109', APP_NAME: 'Stass' },
    },
  ],
});
