import { hkdfSync } from 'node:crypto';

const domains = ['TOTP', 'MAIL', 'FINANCE', 'AML', 'SUSPICION', 'HR', 'DOCUMENT'];

/** Stable, separate keys derived from Render's generated deployment secret. Never rotate this on update. */
export function cloudConfig(source) {
  if (!source.CLOUD_ROOT_KEY || source.CLOUD_ROOT_KEY.length < 32) {
    throw new Error('CLOUD_ROOT_KEY must contain at least 32 random characters.');
  }
  const derive = (purpose) => Buffer.from(hkdfSync('sha256', source.CLOUD_ROOT_KEY,
    'stass-managed-hosting-v1', purpose, 32)).toString('base64');
  const admin = new URL(source.CLOUD_ADMIN_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || !admin.username || !admin.password) {
    throw new Error('CLOUD_ADMIN_DATABASE_URL must be the authenticated external PostgreSQL URL.');
  }
  // A public, CA-signed endpoint is required. Render's internal self-signed endpoint is intentionally unsupported.
  admin.search = '';
  admin.searchParams.set('sslmode', 'verify-full');
  const roleUrl = (role) => {
    const url = new URL(admin);
    url.username = role;
    url.password = derive(`database:${role}`);
    return url.href;
  };
  const base = new URL(source.APP_BASE_URL || source.CLOUD_APP_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('APP_BASE_URL must be the public HTTPS origin, without a path.');
  }
  const runtime = { ...source, NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3001',
    DATABASE_URL: roleUrl('pms_app'), APP_BASE_URL: base.origin, MAIL_FROM_NAME: source.MAIL_FROM_NAME || 'Stass',
    TRUSTED_PROXIES: source.TRUSTED_PROXIES || 'uniquelocal', CLAMAV_PORT: '3310' };
  const version=Number(source.ENCRYPTION_KEY_VERSION||1);
  if(!Number.isInteger(version)||version<1||version>64)throw new Error('Invalid encryption key version.');
  const encryptionKey=(domain,v)=>derive(v===1?`encryption:${domain}`:`encryption:${domain}:v${v}`);
  const previous={};
  for(const domain of domains){
    runtime[`${domain}_ENCRYPTION_KEY`]=encryptionKey(domain,version);
    if(version>1)previous[domain]=Object.fromEntries(Array.from({length:version-1},(_,i)=>[String(i+1),encryptionKey(domain,i+1)]));
  }
  if(version>1)runtime.PREVIOUS_ENCRYPTION_KEYS=JSON.stringify(previous);
  // These credentials are available only to the separate pre-deploy process, never the running API/CLI.
  for (const key of Object.keys(runtime)) {
    if (key.startsWith('CLOUD_') || ['MIGRATION_DATABASE_URL', 'PMS_OWNER_PASSWORD', 'POSTGRES_PASSWORD'].includes(key)) delete runtime[key];
  }
  return { runtime, adminUrl: admin.href, migrationUrl: roleUrl('pms_owner') };
}
