import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const root=resolve(import.meta.dirname,'..');
const {values}=parseArgs({options:{domain:{type:'string'},'smtp-url':{type:'string'},'admin-email':{type:'string'},'admin-name':{type:'string'},'mail-from':{type:'string'},output:{type:'string'},test:{type:'boolean',default:false}}});
const target=resolve(root,values.output??'.env.hosting');
if(dirname(target)!==root||!basename(target).startsWith('.env.hosting'))throw new Error('Hosting settings must use a .env.hosting file in the project root.');
if(existsSync(target)){console.log('Hosting settings already exist. Existing passwords and keys were preserved.');process.exit(0);}
let muted=false;
const output=new Writable({write(chunk,encoding,done){if(!muted)process.stdout.write(chunk);done();}});
const terminal=createInterface({input:process.stdin,output,terminal:process.stdin.isTTY});
async function ask(prompt,secret=false){process.stdout.write(prompt);muted=secret;try{return(await terminal.question('')).trim();}finally{muted=false;if(secret)process.stdout.write('\n');}}
let domain,smtp,email,name,from;
try {
 domain=(values.domain??await ask('Public domain (example: portal.yourfirm.com): ')).toLowerCase().trim();
 email=(values['admin-email']??await ask('First administrator email: ')).trim();
 name=(values['admin-name']??await ask('Administrator name [Practice Administrator]: ')).trim()||'Practice Administrator';
 smtp=(values['smtp-url']??await ask('SMTP URL from your email provider (hidden while typing): ',true)).trim();
 from=(values['mail-from']??await ask(`Verified sender email [${email}]: `)).trim()||email;
} finally {terminal.close();}
if(!(values.test&&domain==='localhost')&&!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))throw new Error('Enter a public domain name without https, a path or a port.');
for(const address of [email,from])if(!/^[^\s@'"$]+@[^\s@'"$]+\.[^\s@'"$]+$/.test(address))throw new Error('A valid administrator and sender email are required.');
if(!/^[\p{L}\p{N} .'-]{1,100}$/u.test(name))throw new Error('Use letters, numbers, spaces, apostrophes, dots or hyphens for the administrator name.');
const smtpUrl=new URL(smtp);
if(!['smtp:','smtps:'].includes(smtpUrl.protocol))throw new Error('SMTP URL must start with smtp:// or smtps://. Production smtp:// requires STARTTLS.');
if(/[\r\n]/.test(smtp))throw new Error('SMTP URL must be one line.');
for(const field of ['username','password'])smtpUrl[field]=encodeURIComponent(decodeURIComponent(smtpUrl[field])).replaceAll("'",'%27');
const secret=()=>randomBytes(24).toString('base64url');
const ownerPassword=secret(),appPassword=secret();
const common={DOMAIN:domain,APP_NAME:'Stass',ADMIN_EMAIL:email,ADMIN_NAME:name,APP_BASE_URL:`https://${domain}${values.test?':18443':''}`,SMTP_URL:smtpUrl.href,MAIL_FROM_ADDRESS:from,POSTGRES_PASSWORD:secret(),PMS_OWNER_PASSWORD:ownerPassword,PMS_APP_PASSWORD:appPassword,DATABASE_URL:`postgres://pms_app:${appPassword}@postgres:5432/pms?sslmode=verify-full&sslrootcert=/certs/ca.crt`,MIGRATION_DATABASE_URL:`postgres://pms_owner:${ownerPassword}@postgres:5432/pms?sslmode=verify-full&sslrootcert=/certs/ca.crt`,DOCUMENTS_S3_ACCESS_KEY:secret(),DOCUMENTS_S3_SECRET_KEY:secret()};
for(const domain of ['TOTP','MAIL','FINANCE','AML','SUSPICION','HR','DOCUMENT'])common[`${domain}_ENCRYPTION_KEY`]=randomBytes(32).toString('base64');
if(values.test)Object.assign(common,{PUBLIC_BIND:'127.0.0.1',HTTP_PORT:'18080',HTTPS_PORT:'18443',RELEASE_TAG:'smoke'});
const quote=value=>value.includes("'")?`"${value}"`:`'${value}'`;
writeFileSync(target,'# Private hosting settings. Keep with your encrypted backups. Do not regenerate for an existing database.\n'+Object.entries(common).map(([key,value])=>`${key}=${quote(value)}`).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log(`Created ${basename(target)} with independent random passwords and keys. No secret values were printed.`);
