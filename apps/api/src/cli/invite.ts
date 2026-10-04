import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { InvitationsService } from '../auth/invitations/invitations.service.js';
import { STAFF_ROLES } from '../auth/permissions/permissions.js';
import { RolesService } from '../auth/permissions/roles.service.js';
import { loadEnv } from '../config/env.js';

/*
 * Invites an account from the command line, run by someone with access to the
 * server and its secrets. Used to create the first administrator, and for
 * client invitations until the Clients module exists.
 *
 *   npm run invite:local -- --kind staff --email jane@firm.example --name "Jane Doe" --role administrator
 *
 * --role may be repeated, and is only for staff. It is how the first
 * administrator is created; after that, administrators invite staff in the app.
 */

const SYSTEM = { actor: { type: 'system' }, accountId: null } as const;

const argsSchema = z
  .strictObject({
    kind: z.enum(['staff', 'client']),
    email: z.email(),
    name: z.string().trim().min(1).max(200),
    role: z.array(z.enum(STAFF_ROLES)).default([]),
  })
  .refine((args) => args.kind === 'staff' || args.role.length === 0, {
    path: ['role'],
    message: 'only staff accounts have roles',
  });

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', multiple: true },
  },
  strict: true,
});

const parsed = argsSchema.safeParse(values);
if (!parsed.success) {
  console.error('Usage: invite --kind staff|client --email <address> --name "<display name>" [--role <role> ...]');
  console.error(`  roles: ${STAFF_ROLES.join(', ')}`);
  console.error(parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n'));
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadEnv(process.env)), {
  logger: ['error', 'warn'],
});

try {
  const { accountId, expiresAt } = await app.get(InvitationsService).invite(
    { kind: parsed.data.kind, email: parsed.data.email, displayName: parsed.data.name },
    SYSTEM,
  );
  for (const role of parsed.data.role) {
    await app.get(RolesService).grant(accountId, role, SYSTEM);
  }
  console.log(`Invitation emailed to ${parsed.data.email}`);
  if (parsed.data.role.length > 0) {
    console.log(`  roles:   ${parsed.data.role.join(', ')}`);
  }
  console.log(`  account: ${accountId}`);
  console.log(`  expires: ${expiresAt.toISOString()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invitation failed');
  process.exitCode = 1;
} finally {
  await app.close();
}
