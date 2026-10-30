import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Production Hygiene Checker (Step 19d & Review F2, F3, C6)
// Verifies that development conveniences, demo credentials, and debug artifacts
// are strictly quarantined and never bundled into production releases.

const rootDir = resolve(import.meta.dirname, '..');
let issuesFound = 0;

function reportIssue(message) {
  // eslint-disable-next-line no-console
  console.error(`[FAIL] ${message}`);
  issuesFound++;
}

function reportPass(message) {
  // eslint-disable-next-line no-console
  console.log(`[PASS] ${message}`);
}

// eslint-disable-next-line no-console
console.log('Verifying production deployment hygiene...\n');

// 1. Check that secrets and demo credentials are not committed
const gitIgnorePath = resolve(rootDir, '.gitignore');
if (existsSync(gitIgnorePath)) {
  const gitIgnore = readFileSync(gitIgnorePath, 'utf8');
  if (!gitIgnore.includes('.env')) {
    reportIssue('.gitignore must contain .env');
  } else {
    reportPass('.env is properly git-ignored');
  }

  if (!gitIgnore.includes('DEMO-LOGIN.txt')) {
    reportIssue('.gitignore must contain DEMO-LOGIN.txt');
  } else {
    reportPass('DEMO-LOGIN.txt is properly git-ignored');
  }
}

// 2. Check compose.yaml binds database and internal services to 127.0.0.1 only
const composePath = resolve(rootDir, 'compose.yaml');
if (existsSync(composePath)) {
  const compose = readFileSync(composePath, 'utf8');
  if (compose.includes('"0.0.0.0:5432') || compose.includes('":5432:5432"')) {
    reportIssue('PostgreSQL must not bind to public interface 0.0.0.0');
  } else if (compose.includes('"127.0.0.1:5432:5432"')) {
    reportPass('PostgreSQL is safely bound to loopback 127.0.0.1 only');
  }
}

// 3. Check that Edge Proxy configuration exists and enforces Review F2 limits
const nginxProxyPath = resolve(rootDir, 'infra/proxy/nginx.conf');
const caddyProxyPath = resolve(rootDir, 'infra/proxy/Caddyfile');

if (existsSync(nginxProxyPath) && existsSync(caddyProxyPath)) {
  const nginxConf = readFileSync(nginxProxyPath, 'utf8');
  if (nginxConf.includes('client_max_body_size 52m;') && nginxConf.includes('client_max_body_size 1m;')) {
    reportPass('Nginx edge reverse proxy enforces 52 MB upload / 1 MB default boundaries (Review F2)');
  } else {
    reportIssue('Nginx proxy configuration missing 52m/1m payload boundaries');
  }

  const caddyConf = readFileSync(caddyProxyPath, 'utf8');
  if (caddyConf.includes('max_size 52MB') && caddyConf.includes('max_size 1MB')) {
    reportPass('Caddy edge reverse proxy enforces 52 MB upload / 1 MB default boundaries (Review F2)');
  } else {
    reportIssue('Caddy proxy configuration missing 52MB/1MB payload boundaries');
  }
} else {
  reportIssue('Production edge proxy configurations missing in infra/proxy/');
}

// 4. Check that Disaster Recovery and Encrypted Backup runbook exists (Review C6)
const drPath = resolve(rootDir, 'docs/disaster-recovery.md');
if (existsSync(drPath)) {
  const drContent = readFileSync(drPath, 'utf8');
  if (['RPO','RTO','quarantin','verify-restored-disposals.mjs','does NOT replay historical disposal','EMPTY marker'].every(term=>drContent.includes(term))) {
    reportPass('Recovery runbook records targets, quarantine, disposal verification and correct recovery configuration');
  } else {
    reportIssue('Disaster recovery documentation missing required RPO/RTO or tombstone replay rules');
  }
}

// eslint-disable-next-line no-console
console.log('');
if (issuesFound > 0) {
  // eslint-disable-next-line no-console
  console.error(`Production hygiene check FAILED with ${issuesFound} issue(s).`);
  process.exit(1);
} else {
  // eslint-disable-next-line no-console
  console.log('All production hygiene checks PASSED.');
}
