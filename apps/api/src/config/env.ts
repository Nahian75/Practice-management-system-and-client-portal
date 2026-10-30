import { isIP } from 'node:net';
import { z } from 'zod';

const PROXY_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isProxyEntry(entry: string): boolean {
  if (PROXY_PRESETS.has(entry)) {
    return true;
  }
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (family === 4 ? 32 : 128);
}

/**
 * Addresses of proxies whose X-Forwarded-For header is believed, comma-separated:
 * IPs, CIDR ranges, or Express presets. Empty (the default) believes no one, so
 * a client cannot choose the address it is rate-limited and audited under.
 */
export const trustedProxiesSchema = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
  .refine((entries) => entries.every(isProxyEntry), {
    message: 'must be a comma-separated list of IP addresses, CIDR ranges, loopback, linklocal or uniquelocal',
  });

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] as const;

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

const ENCRYPTION_KEY_BYTES = 32;

/** A random 256-bit key, base64-encoded. */
export const encryptionKeySchema = z
  .base64()
  .refine((value) => Buffer.from(value, 'base64').length === ENCRYPTION_KEY_BYTES, {
    message: `must be ${ENCRYPTION_KEY_BYTES} random bytes, base64-encoded`,
  });

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
    ENCRYPTION_KEY_VERSION:z.coerce.number().int().min(1).max(64).optional(),
    PREVIOUS_ENCRYPTION_KEYS:z.string().transform((value,ctx)=>{
      if(value==='')return {};
      try{return JSON.parse(value) as unknown;}catch{ctx.addIssue({code:'custom',message:'must be valid key-ring JSON'});return z.NEVER;}
    }).pipe(z.partialRecord(z.enum(['TOTP','MAIL','FINANCE','AML','SUSPICION','HR','DOCUMENT']),z.record(z.string().regex(/^[1-9]\d?$/),encryptionKeySchema))).optional(),
    NODE_ENV: nodeEnvSchema,
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('log'),
    DATABASE_URL: postgresUrlSchema,
    TOTP_ENCRYPTION_KEY: encryptionKeySchema,
    /** Where users open the app. Links in emails point here. */
    APP_BASE_URL: z.url({ protocol: /^https?$/ }),
    /** smtp://host:port for STARTTLS or a local catcher, smtps://user:pass@host:465 for implicit TLS. */
    SMTP_URL: z.url({ protocol: /^smtps?$/ }),
    MAIL_FROM_ADDRESS: z.email(),
    MAIL_FROM_NAME: z.string().min(1).max(100).default('Practice Portal'),
    /** Seals queued email addresses, subjects and bodies before they enter PostgreSQL. */
    MAIL_ENCRYPTION_KEY: encryptionKeySchema,
    /** Seals firm and client bank details before they enter PostgreSQL. */
    FINANCE_ENCRYPTION_KEY: encryptionKeySchema,
    /** Seals AML identity data and each protected evidence file key. */
    AML_ENCRYPTION_KEY: encryptionKeySchema,
    /** Seals internal disclosures, SAR/DAML decisions and their file keys. */
    SUSPICION_ENCRYPTION_KEY: encryptionKeySchema,
    /** Seals personnel data and each private HR file key. */
    HR_ENCRYPTION_KEY: encryptionKeySchema,
    /** The official UK Sanctions List CSV, checked every six hours. Unset: lists are only uploaded by hand. */
    SANCTIONS_LIST_URL: z.url({ protocol: /^https$/ }).optional(),
    /** Official UK Companies House API credentials. Unset: registry verification is manual-only. */
    COMPANIES_HOUSE_API_KEY: z.string().min(1).optional(),
    COMPANIES_HOUSE_API_URL: z.url({ protocol: /^https?$/ }).optional(),
    TRUSTED_PROXIES: trustedProxiesSchema,
    /** S3-compatible storage for documents: SeaweedFS locally (docs/documents.md). */
    DOCUMENTS_S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
    DOCUMENTS_S3_REGION: z.string().min(1).default('eu-west-2'),
    DOCUMENTS_S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    DOCUMENTS_S3_ACCESS_KEY: z.string().min(1),
    DOCUMENTS_S3_SECRET_KEY: z.string().min(16),
    /** Seals each document's own key. Losing it makes every stored document unreadable. */
    DOCUMENT_ENCRYPTION_KEY: encryptionKeySchema,
    /** ClamAV's daemon. It has no authentication: reachable only on a private network. */
    CLAMAV_HOST: z.string().min(1).default('127.0.0.1'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  })
  .superRefine(requireVerifiedTlsInProduction('DATABASE_URL'))
  .superRefine((env, ctx) => {
    const version=env.ENCRYPTION_KEY_VERSION??1;
    for(const purpose of ['TOTP','MAIL','FINANCE','AML','SUSPICION','HR','DOCUMENT'] as const){
      const previous=env.PREVIOUS_ENCRYPTION_KEYS?.[purpose]??{};
      if(version>1&&!previous['1'])ctx.addIssue({code:'custom',path:['PREVIOUS_ENCRYPTION_KEYS'],message:`must retain the original ${purpose} key for existing records and fingerprints`});
      for(const [old,key] of Object.entries(previous))if(Number(old)>=version||key===env[`${purpose}_ENCRYPTION_KEY`])ctx.addIssue({code:'custom',path:['PREVIOUS_ENCRYPTION_KEYS'],message:'previous keys must have older versions and differ from current keys'});
    }
    for (const key of ['TOTP_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY','FINANCE_ENCRYPTION_KEY','DOCUMENT_ENCRYPTION_KEY'] as const) {
      if (env.AML_ENCRYPTION_KEY === env[key]) {
        ctx.addIssue({ code:'custom', path:['AML_ENCRYPTION_KEY'], message:`must be separate from ${key}` });
      }
    }
    for (const key of ['TOTP_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY','FINANCE_ENCRYPTION_KEY','DOCUMENT_ENCRYPTION_KEY','AML_ENCRYPTION_KEY'] as const) {
      if (env.SUSPICION_ENCRYPTION_KEY === env[key]) {
        ctx.addIssue({ code:'custom', path:['SUSPICION_ENCRYPTION_KEY'], message:`must be separate from ${key}` });
      }
    }
    for (const key of ['TOTP_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY','FINANCE_ENCRYPTION_KEY','DOCUMENT_ENCRYPTION_KEY','AML_ENCRYPTION_KEY','SUSPICION_ENCRYPTION_KEY'] as const) {
      if (env.HR_ENCRYPTION_KEY === env[key]) {
        ctx.addIssue({ code:'custom', path:['HR_ENCRYPTION_KEY'], message:`must be separate from ${key}` });
      }
    }
    for (const key of ['APP_BASE_URL', 'DOCUMENTS_S3_ENDPOINT'] as const) {
      if (env.NODE_ENV === 'production' && new URL(env[key]).protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must use https in production' });
      }
    }
  });

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
