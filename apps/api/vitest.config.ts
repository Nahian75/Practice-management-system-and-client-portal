import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const LOCAL_ENV_FILE = '.env';

// Values already set in the environment (as in CI) take precedence over the file.
if (existsSync(LOCAL_ENV_FILE)) {
  process.loadEnvFile(LOCAL_ENV_FILE);
}

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
  },
});
