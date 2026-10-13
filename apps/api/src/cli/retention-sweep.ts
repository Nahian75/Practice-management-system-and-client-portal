import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { loadEnv } from '../config/env.js';
import { SecurityRetentionService } from '../auth/retention/security-retention.service.js';

/*
 * Automated Ephemeral Security Data Retention CLI (Review F3)
 *
 * Runs scheduled purging of expired sessions, old sign-in failures,
 * closed password resets, closed invitations, and cleared email outbox items.
 *
 * Usage:
 *   npm run retention:sweep:local
 *   npm run retention:sweep -- --sessions 30 --failures 90 --resets 7 --invitations 14 --outbox 30
 */

const { values } = parseArgs({
  options: {
    sessions: { type: 'string' },
    failures: { type: 'string' },
    resets: { type: 'string' },
    invitations: { type: 'string' },
    outbox: { type: 'string' },
  },
  strict: false,
});

const sessionsDays = values.sessions ? Number(values.sessions) : 30;
const failuresDays = values.failures ? Number(values.failures) : 90;
const resetsDays = values.resets ? Number(values.resets) : 7;
const invitationsDays = values.invitations ? Number(values.invitations) : 14;
const outboxDays = values.outbox ? Number(values.outbox) : 30;

const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadEnv(process.env)), {
  logger: ['error', 'warn'],
});

try {
  const retentionService = app.get(SecurityRetentionService);
  const result = await retentionService.purgeExpiredEphemeralData({
    sessionsRetentionDays: sessionsDays,
    failuresRetentionDays: failuresDays,
    resetsRetentionDays: resetsDays,
    invitationsRetentionDays: invitationsDays,
    outboxRetentionDays: outboxDays,
  });

  // eslint-disable-next-line no-console
  console.log(`Ephemeral security data retention sweep completed:`);
  // eslint-disable-next-line no-console
  console.log(`  - Purged Sessions:        ${result.purgedSessions}`);
  // eslint-disable-next-line no-console
  console.log(`  - Purged Sign-in Failures:${result.purgedSignInFailures}`);
  // eslint-disable-next-line no-console
  console.log(`  - Purged Password Resets: ${result.purgedPasswordResets}`);
  // eslint-disable-next-line no-console
  console.log(`  - Purged Invitations:     ${result.purgedInvitations}`);
  // eslint-disable-next-line no-console
  console.log(`  - Purged Email Outbox:    ${result.purgedEmailOutbox}`);
  // eslint-disable-next-line no-console
  console.log(`  - Total Purged Rows:      ${result.totalPurged}`);
} finally {
  await app.close();
}
