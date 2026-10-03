import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { InvitationsService } from '../auth/invitations/invitations.service.js';
import { loadEnv } from '../config/env.js';

/*
 * Invites an account from the command line. Until staff roles exist, this is
 * the only way to create an account, so only someone with access to the
 * server and its secrets can do it.
 *
 *   npm run invite:local -- --kind staff --email jane@firm.example --name "Jane Doe"
 */

const argsSchema = z.strictObject({
  kind: z.enum(['staff', 'client']),
  email: z.email(),
  name: z.string().trim().min(1).max(200),
});

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
  },
  strict: true,
});

const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error('Usage: invite --kind staff|client --email <address> --name "<display name>"');
  console.error(parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'));
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadEnv(process.env)), {
  logger: ['error', 'warn'],
});

try {
  const { accountId, expiresAt } = await app.get(InvitationsService).invite(
    { kind: parsed.data.kind, email: parsed.data.email, displayName: parsed.data.name },
    { actor: { type: 'system' }, accountId: null },
  );
  console.log(`Invitation emailed to ${parsed.data.email}`);
  console.log(`  account: ${accountId}`);
  console.log(`  expires: ${expiresAt.toISOString()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invitation failed');
  process.exitCode = 1;
} finally {
  await app.close();
}
