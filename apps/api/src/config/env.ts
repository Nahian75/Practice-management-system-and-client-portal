import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/**
 * In production the database connection must be encrypted and the server's
 * certificate checked, otherwise credentials and client data cross the network
 * readable by anyone in between.
 */
export function requireVerifiedTlsInProduction<Key extends string>(key: Key) {
  return (env: { NODE_ENV: string } & Record<Key, string>, ctx: z.RefinementCtx): void => {
    if (env.NODE_ENV !== 'production') {
      return;
    }
    if (new URL(env[key]).searchParams.get('sslmode') !== 'verify-full') {
      ctx.addIssue({ code: 'custom', path: [key], message: 'must set sslmode=verify-full in production' });
    }
  };
}

const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
    DATABASE_URL: postgresUrlSchema,
  })
  .superRefine(requireVerifiedTlsInProduction('DATABASE_URL'));

export type Env = z.infer<typeof envSchema>;

export class InvalidEnvError extends Error {
  override readonly name = 'InvalidEnvError';
}

export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: Record<string, string | undefined>,
): z.infer<Schema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    // Only the variable name and the rule it broke. The value itself may be a secret.
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new InvalidEnvError(`Invalid environment configuration:\n${problems.join('\n')}`);
  }

  return result.data;
}

export function loadEnv(source: Record<string, string | undefined>): Env {
  return parseEnv(envSchema, source);
}
