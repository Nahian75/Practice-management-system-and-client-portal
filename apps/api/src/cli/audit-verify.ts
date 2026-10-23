import { parseArgs } from 'node:util';
import { z } from 'zod';
import { verifyAuditChain, type Checkpoint } from '../audit/chain/audit-chain-verifier.js';
import { nodeEnvSchema, parseEnv, postgresUrlSchema, requireVerifiedTlsInProduction } from '../config/env.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

/*
 * Checks the audit log against its hash chain and against checkpoints from
 * the daily emails (docs/audit.md). Exits 1 if anything does not match.
 *
 * Usage:
 *   npm run audit:verify:local -- --checkpoint 1234:<fingerprint> [--checkpoint ...]
 */

const CHECKPOINT = /^([1-9][0-9]*):([0-9a-fA-F]{64})$/;

const env = parseEnv(
  z.object({ NODE_ENV: nodeEnvSchema, DATABASE_URL: postgresUrlSchema }).superRefine(requireVerifiedTlsInProduction('DATABASE_URL')),
  process.env,
);
const { values } = parseArgs({ options: { checkpoint: { type: 'string', multiple: true } } });
const checkpoints: Checkpoint[] = (values.checkpoint ?? []).map((value) => {
  const match = CHECKPOINT.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Not a checkpoint: ${value}. Use <seal number>:<fingerprint>, as in the email`);
  }
  return { seq: match[1], hash: match[2] };
});

const db = createDatabase<Database>(env.DATABASE_URL, 1);
try {
  const report = await verifyAuditChain(db, checkpoints);
  console.log(`Seals checked: ${report.seals}`);
  if (report.head) {
    console.log(`Latest seal: ${report.head.seq}:${report.head.hash}`);
  }
  for (const problem of report.problems) {
    console.error(`Seal ${problem.seq}: ${problem.problem.replace('_', ' ')}`);
  }
  for (const checkpoint of report.brokenCheckpoints) {
    console.error(`Checkpoint ${checkpoint.seq} does not match: the chain was changed or rebuilt after it was emailed`);
  }
  if (report.unsealed > 0) {
    console.error(`${report.unsealed} events over an hour old have no seal`);
  }
  if (report.problems.length > 0 || report.brokenCheckpoints.length > 0 || report.unsealed > 0) {
    console.error('The audit log does NOT match its record.');
    process.exitCode = 1;
  } else {
    console.log(`The audit log matches its record${checkpoints.length > 0 ? ' and every checkpoint given' : ''}.`);
  }
} finally {
  await db.destroy();
}
