import { cloudConfig } from './cloud-config.mjs';
import { loadEnv } from '../../apps/api/dist/config/env.js';

try {
  const { runtime } = cloudConfig(process.env);
  loadEnv(runtime);
  const task = process.argv[2] || 'api';
  const commands = {
    api: ['--enable-source-maps', 'dist/main.js'],
    retention: ['dist/cli/retention-sweep.js'],
    verify: ['/app/infra/hosting/check-services.mjs'],
    invite: ['dist/cli/invite.js', ...process.argv.slice(3)],
  };
  if (!commands[task]) throw new Error('Unknown cloud task. Use api, retention, verify or invite.');
  // Linux exec replaces this process, removing bootstrap credentials from /proc and the API environment.
  process.execve(process.execPath, [process.execPath, ...commands[task]], runtime);
} catch {
  console.error('Cloud startup failed. Check the managed hosting configuration; secret values are not logged.');
  process.exitCode = 1;
}
