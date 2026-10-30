import {createHash,createPrivateKey,createPublicKey,sign,verify,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {S3Client,ListObjectsV2Command,GetObjectCommand,GetObjectLockConfigurationCommand,PutObjectCommand} from '@aws-sdk/client-s3';

const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const uuid=/^[0-9a-f-]{36}$/i;
export function makeCheckpoint(deployment,events,disposals,privateKey,previous=null){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(deployment))throw new Error('Invalid deployment identifier');
 const rows=events.map(row=>({id:row.id,sha256:digest(row)}));
 if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('Duplicate audit identifiers');
 if(previous){
  if(previous.deployment!==deployment)throw new Error('Checkpoint belongs to another deployment');
  const current=new Map(rows.map(row=>[row.id,row.sha256]));
  for(const row of previous.rows)if(current.get(row.id)!==row.sha256)throw new Error('Audit modification/deletion detected');
  const keys=new Set(disposals.map(row=>`${row.kind}:${row.id}`));
  for(const row of previous.disposals)if(!keys.has(`${row.kind}:${row.id}`))throw new Error('Disposal-journal deletion detected');
 }
 const payload={format:1,deployment,createdAt:new Date().toISOString(),previousDigest:previous?digest(previous):null,rows,disposals};
 const key=createPrivateKey(privateKey);
 if(key.asymmetricKeyType!=='ed25519')throw new Error('Ed25519 checkpoint signing key required');
 return {payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64')};
}
export function verifyCheckpoint(checkpoint,publicKey,deployment){
 if(!checkpoint?.payload||checkpoint.payload.format!==1||checkpoint.payload.deployment!==deployment||
   !Array.isArray(checkpoint.payload.rows)||!Array.isArray(checkpoint.payload.disposals)||
   !verify(null,Buffer.from(canonical(checkpoint.payload)),publicKey,Buffer.from(checkpoint.signature??'','base64')))
  throw new Error('Checkpoint verification failed');
 for(const row of checkpoint.payload.rows)if(!uuid.test(row.id)||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('Invalid audit manifest');
 for(const row of checkpoint.payload.disposals)if(!uuid.test(row.id)||!/^(aml|hr)_[a-z_]+$/.test(row.kind))throw new Error('Invalid disposal manifest');
 if(!Number.isFinite(Date.parse(checkpoint.payload.createdAt))||Date.parse(checkpoint.payload.createdAt)>Date.now()+300000)throw new Error('Invalid checkpoint timestamp');
 if(new Set(checkpoint.payload.rows.map(row=>row.id)).size!==checkpoint.payload.rows.length)throw new Error('Duplicate audit identifiers');
 return checkpoint.payload;
}

export async function collectEvidence(db){
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const events=[];let cursor=null;
  for(;;){
   const {rows}=await db.query('SELECT * FROM app.audit_events WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 5000',[cursor]);
   events.push(...rows);if(events.length>1_000_000)throw new Error('Checkpoint capacity exceeded; partition the independent audit manifest');
   if(rows.length<5000)break;cursor=rows.at(-1).id;
  }
  const {rows:disposals}=await db.query(`SELECT record_kind AS kind,record_id::text AS id FROM app.aml_disposed_records
    UNION SELECT record_kind AS kind,record_id::text AS id FROM app.hr_disposed_records ORDER BY kind,id`);
  await db.query('COMMIT');return{events,disposals};
 }catch(error){await db.query('ROLLBACK');throw error;}
}

async function main(){
 const required=name=>{const value=process.env[name];if(!value)throw new Error('Missing '+name);return value;};
 const deployment=required('AUDIT_DEPLOYMENT_ID');
 const url=new URL(required('AUDIT_DATABASE_URL'));
 if(url.searchParams.get('sslmode')!=='verify-full')throw new Error('Verified database TLS is required');
 const signingKey=required('AUDIT_SIGNING_KEY_PEM');
 const publicKey=createPublicKey(createPrivateKey(signingKey));
 const bucket=required('AUDIT_S3_BUCKET'),prefix=`checkpoints/${deployment}/`;
 const s3=new S3Client({region:required('AUDIT_S3_REGION'),credentials:{accessKeyId:required('AUDIT_S3_ACCESS_KEY'),secretAccessKey:required('AUDIT_S3_SECRET_KEY')}});
 const db=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000,statement_timeout:15000});
 try{
  const lock=await s3.send(new GetObjectLockConfigurationCommand({Bucket:bucket}));
  if(lock.ObjectLockConfiguration?.ObjectLockEnabled!=='Enabled')throw new Error('Independent bucket must have Object Lock enabled');
  let continuation,latest;
  do{
   const list=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,ContinuationToken:continuation}));
   for(const object of list.Contents??[])if(object.Key?.endsWith('.json')&&(!latest||object.Key>latest))latest=object.Key;
   continuation=list.NextContinuationToken;
  }while(continuation);
  let previous=null;
  if(latest){
   const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:latest}));
   if((object.ContentLength??0)>100*1024*1024)throw new Error('Checkpoint exceeds the size limit');
   previous=verifyCheckpoint(JSON.parse(await object.Body.transformToString()),publicKey,deployment);
  }else if(process.env.AUDIT_INITIALIZE!=='1')throw new Error('Initial checkpoint requires explicit initialization approval');
  await db.connect();
  const {rows:[role]}=await db.query(`SELECT r.rolsuper,r.rolcreaterole,
    (has_table_privilege(current_user,'app.audit_events','INSERT,UPDATE,DELETE,TRUNCATE') OR
    has_any_column_privilege(current_user,'app.audit_events','INSERT,UPDATE')) AS can_mutate
    FROM pg_roles r WHERE rolname=current_user`);
  if(!role||role.rolsuper||role.rolcreaterole||role.can_mutate)throw new Error('Independent checkpoint reader must not mutate audit records');
  const {events,disposals}=await collectEvidence(db);
  const checkpoint=makeCheckpoint(deployment,events,disposals,signingKey,previous);
  const body=JSON.stringify(checkpoint);
  if(Buffer.byteLength(body)>100*1024*1024)throw new Error('Checkpoint exceeds the size limit');
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:prefix+new Date().toISOString()+'-'+randomUUID()+'.json',Body:body,
   ContentType:'application/json',ChecksumAlgorithm:'SHA256',ServerSideEncryption:'aws:kms',SSEKMSKeyId:required('AUDIT_S3_KMS_KEY_ID'),
   ObjectLockMode:'COMPLIANCE',ObjectLockRetainUntilDate:new Date(Date.now()+365*86400000)}));
  console.log(`Verified and retained independent checkpoint: ${events.length} audit rows; ${disposals.length} disposal identifiers.`);
 }finally{await db.end();s3.destroy();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(()=>{console.error('Audit checkpoint failed. Investigate availability, permissions and integrity; secret values are not logged.');process.exitCode=1;});
}
