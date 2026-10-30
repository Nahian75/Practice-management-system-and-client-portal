// Local isolated recovery exercise. Never accepts a production source/target name.
import pg from 'pg';
import{spawnSync}from'node:child_process';
import{randomBytes,createCipheriv,createDecipheriv,createHash}from'node:crypto';
import{mkdirSync,writeFileSync}from'node:fs';
import{resolve}from'node:path';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'apps/api/.env'));
const source=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(source.hostname)||source.pathname!=='/pms_test')throw new Error('Drill requires the isolated local pms_test database');
const target='pms_restore_audit_'+randomBytes(8).toString('hex');
const checkedTarget=()=>{if(!/^pms_restore_audit_[a-f0-9]{16}$/.test(target))throw new Error('Unsafe restore target');return target;};
function docker(args,input){const result=spawnSync('docker',['compose','exec','-T','postgres',...args],{cwd:root,input,maxBuffer:256*1024*1024});if(result.status!==0)throw new Error('Restore drill command failed: '+args[0]);return result.stdout;}
async function manifest(db){
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='app' ORDER BY tablename")).rows;
 const result=[];
 for(const{tablename:name}of tables){
  if(!/^[a-z_0-9]+$/.test(name))throw new Error('Unexpected table identifier');
  const{rows:[row]}=await db.query(`SELECT count(*)::text AS count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') AS digest FROM app."${name}" t`);
  result.push({table:name,...row});
 }
 return result;
}
const started=Date.now(),db=new pg.Client({connectionString:source.href,connectionTimeoutMillis:5000});let restored;
mkdirSync(resolve(root,'logs/restore-drill'),{recursive:true});
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL timezone='UTC'");
 const snapshot=(await db.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
 const expected=await manifest(db);
 const dump=docker(['pg_dump','-U','postgres','-Fc','--snapshot='+snapshot,'pms_test']);
 await db.query('COMMIT');
 const key=randomBytes(32),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 const encrypted=Buffer.concat([cipher.update(dump),cipher.final()]),tag=cipher.getAuthTag();
 writeFileSync(resolve(root,'logs/restore-drill/backup.enc'),Buffer.concat([nonce,tag,encrypted]),{mode:0o600});
 const decipher=createDecipheriv('aes-256-gcm',key,nonce).setAuthTag(tag);
 const recovered=Buffer.concat([decipher.update(encrypted),decipher.final()]);
 if(!createHash('sha256').update(dump).digest().equals(createHash('sha256').update(recovered).digest()))throw new Error('Backup integrity failed');
 docker(['psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',`CREATE DATABASE "${checkedTarget()}"`]);
 docker(['pg_restore','-U','postgres','--exit-on-error','--single-transaction','-d',checkedTarget()],recovered);
 const targetUrl=new URL(source);targetUrl.pathname='/'+checkedTarget();
 restored=new pg.Client({connectionString:targetUrl.href,connectionTimeoutMillis:5000});await restored.connect();await restored.query("SET timezone='UTC'");
 const actual=await manifest(restored);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Restored table counts/content hashes differ');
 const evidence={kind:'isolated local logical backup and restore',source:'pms_test',targetPrefix:'pms_restore_audit_',tables:actual.length,
  dataIntegrityVerified:true,encryption:'AES-256-GCM',durationSeconds:Math.round((Date.now()-started)/1000),
  productionRpoVerified:false,objectStorageRecoveryVerified:false,productionSignoff:false};
 writeFileSync(resolve(root,'logs/restore-drill/evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
}catch{console.error('Isolated restore drill failed; investigate the local environment and backup/restore tooling.');process.exitCode=1;}
finally{
 await restored?.end();await db.end();
 docker(['psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',`DROP DATABASE IF EXISTS "${checkedTarget()}" WITH (FORCE)`]);
}
