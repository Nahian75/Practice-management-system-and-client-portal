import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {makeCheckpoint} from '../infra/hosting/audit-checkpoint.mjs';
const root=resolve(import.meta.dirname,'..');
process.loadEnvFile(resolve(root,'apps/api/.env'));
const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/pms_test')throw new Error('Requires isolated local pms_test');
test('disposal verifier checks real schema and rejects known resurrected or unknown categories',async()=>{
 const db=new pg.Client({connectionString:url.href});await db.connect();
 const folder=mkdtempSync(resolve(tmpdir(),'stass-disposal-'));
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const deployment='local-test-'+randomUUID(),file=resolve(folder,'checkpoint.json');
 const run=disposals=>{
  writeFileSync(file,JSON.stringify(makeCheckpoint(deployment,[],disposals,privateKey.export({type:'pkcs8',format:'pem'}))));
  return spawnSync(process.execPath,['infra/hosting/verify-restored-disposals.mjs',file],{cwd:root,encoding:'utf8',env:{...process.env,
   RESTORE_DATABASE_URL:url.href,AUDIT_DEPLOYMENT_ID:deployment,AUDIT_VERIFY_KEY_PEM:publicKey.export({type:'spki',format:'pem'})}});
 };
 try{
  const mapping=JSON.parse(readFileSync(resolve(root,'infra/hosting/disposal-tables.json')));
  const {rows:columns}=await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='app'");
  for(const entry of Object.values(mapping)){
   const table=typeof entry==='string'?entry:entry.table,column=typeof entry==='string'?'id':entry.column;
   assert.ok(columns.some(row=>row.table_name===table&&row.column_name===column),'Mapped disposal identifier must exist: '+table);
  }
  assert.equal(run([{kind:'aml_cdd_subject',id:randomUUID()}]).status,0);
  assert.equal(run([{kind:'aml_unreviewed_category',id:randomUUID()}]).status,1);
  // A signed journal identifying a currently present row must keep recovery quarantined.
  const {rows}=await db.query('SELECT id FROM app.aml_cdd_cases LIMIT 1');
  assert.ok(rows.length,'API suite must populate recovery verification data first');
  assert.equal(run([{kind:'aml_cdd_case',id:rows[0].id}]).status,1);
 }finally{await db.end();if(existsSync(file))unlinkSync(file);rmdirSync(folder);}
});
