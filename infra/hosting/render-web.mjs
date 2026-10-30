import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const host = process.env.API_HOST;
if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('API_HOST must be the Render private API hostname.');
if (!/^\d+$/.test(process.env.PORT || '10000')) throw new Error('Invalid listening port.');
const environment = { ...process.env, API_URL: `http://${host}:3001` };
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timeout = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 10000);
  timeout.unref();
  if (!children.size) process.exit(code);
  process.exitCode = code;
}
function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  children.add(child);
  child.once('error', () => { console.error('Managed web process failed to start.'); children.delete(child); stop(1); });
  child.once('exit', (code) => { children.delete(child); if (!stopping) stop(code || 1); });
  return child;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(0));
start(process.execPath, ['apps/web/server.js'], { ...environment, HOSTNAME: '127.0.0.1', PORT: '3000' });
let ready = false;
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  ready = await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 3000 });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (ready) break;
  await delay(500);
}
if (!stopping) {
  if (!ready) { console.error('Next.js did not become ready.'); stop(1); }
  else start('caddy', ['run', '--config', '/app/infra/hosting/render.Caddyfile', '--adapter', 'caddyfile'], environment);
}
