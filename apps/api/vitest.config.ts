import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const LOCAL_ENV_FILE = '.env';
const EXCLUSIVE_SPECS = 'src/**/*.exclusive.spec.ts';

// Values already set in the environment (as in CI) take precedence over the file.
if (existsSync(LOCAL_ENV_FILE)) {
  process.loadEnvFile(LOCAL_ENV_FILE);
}

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    // Integration tests talk to PostgreSQL and Mailpit; Vitest's 5-second default is meant for unit tests.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: { name: 'main', include: ['src/**/*.spec.ts'], exclude: [EXCLUSIVE_SPECS], sequence: { groupOrder: 0 } },
      },
      {
        // Tests of rules about the whole database (such as "at least one
        // administrator") change data every other test relies on, so they run
        // after the rest, one file at a time.
        extends: true,
        test: { name: 'exclusive', include: [EXCLUSIVE_SPECS], fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
