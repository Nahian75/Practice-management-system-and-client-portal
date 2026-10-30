import{readFileSync}from'node:fs';
import pg from'pg';
import{verifyCheckpoint}from'./audit-checkpoint.mjs';
// Operator approval is required before using restored data. This check never
// guesses how to purge a category and never releases restored traffic itself.
const required=name=>{if(!process.env[name])throw new Error('Missing '+name);return process.env[name];};
const checkpoint=JSON.parse(readFileSync(process.argv[2]??'','utf8'));
const payload=verifyCheckpoint(checkpoint,required('AUDIT_VERIFY_KEY_PEM'),required('AUDIT_DEPLOYMENT_ID'));
if(Date.now()-Date.parse(payload.createdAt)>60*60_000)throw new Error('Obtain a current independently verified disposal journal before releasing restored data');
const mapping=JSON.parse(readFileSync(new URL('./disposal-tables.json',import.meta.url),'utf8'));
const restoreUrl=new URL(required('RESTORE_DATABASE_URL'));
if(!['127.0.0.1','localhost','[::1]'].includes(restoreUrl.hostname)&&restoreUrl.searchParams.get('sslmode')!=='verify-full')throw new Error('Remote recovery verification requires verified database TLS');
const db=new pg.Client({connectionString:restoreUrl.href,connectionTimeoutMillis:5000,statement_timeout:10000});
try{
 await db.connect();await db.query('BEGIN READ ONLY');let found=0;
 for(const record of payload.disposals){
  const entry=mapping[record.kind],table=typeof entry==='string'?entry:entry?.table,column=typeof entry==='string'?'id':entry?.column;
  if(!table||!/^(aml|hr)_[a-z_]+$/.test(table)||!['id','report_id'].includes(column))throw new Error('Unknown disposal category requires reviewed manual verification');
  const{rows:[result]}=await db.query(`SELECT EXISTS(SELECT 1 FROM app."${table}" WHERE "${column}"=$1::uuid) AS present`,[record.id]);
  if(result.present)found++;
 }
 await db.query('ROLLBACK');
 if(found)throw new Error('Restored disposed records detected; keep the database quarantined and perform approved disposal replay');
 console.log('Disposal identifiers in the signed journal are absent. Officer review of journal completeness and object storage remains required.');
}catch{console.error('Restored disposal verification failed; the restored database must remain quarantined.');process.exitCode=1;}
finally{await db.end();}
