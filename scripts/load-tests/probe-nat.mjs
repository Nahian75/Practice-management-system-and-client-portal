// Follow-up to run-local.mjs: bounded office-NAT throttling probe, no remote target.
import 'reflect-metadata';
import {randomBytes,randomInt,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createDatabase} from '../../apps/api/dist/database/database.js';

const root=resolve(import.meta.dirname,'../..');process.loadEnvFile(join(root,'apps/api/.env'));
const reportPath=readFileSync(join(root,'logs/load-tests/latest-report-path.txt'),'utf8').trim();
if(!resolve(reportPath).startsWith(join(root,'logs/load-tests')+'\\')&&!resolve(reportPath).startsWith(join(root,'logs/load-tests')+'/'))throw new Error('Invalid local report path');
const previous=JSON.parse(readFileSync(reportPath)),folder=resolve(reportPath,'..');
if(previous.virtualUsers!==100||previous.counts.clients!==2100)throw new Error('Run the isolated main load exercise first');
const localUrl=value=>{const u=new URL(value??'');if(!['127.0.0.1','localhost'].includes(u.hostname))throw new Error('Only loopback is allowed');u.pathname='/pms_e2e';return u.href;};
for(const key of ['SMTP_URL','DOCUMENTS_S3_ENDPOINT'])if(!['127.0.0.1','localhost'].includes(new URL(process.env[key]??'').hostname))throw new Error('Local services required');
for(const port of [3201,3203]){const portFree=await new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',()=>resolve(true));});
if(!portFree)throw new Error('Dedicated test port is occupied');}
const db=createDatabase(localUrl(process.env.TEST_MIGRATION_DATABASE_URL),2);
let child;const children=[];
const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'3201',DATABASE_URL:localUrl(process.env.TEST_DATABASE_URL),
 APP_BASE_URL:'http://127.0.0.1:3200',TRUSTED_PROXIES:'loopback',LOG_LEVEL:'error',DOCUMENTS_S3_BUCKET:'pms-documents-e2e',CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:'3310',ENCRYPTION_KEY_VERSION:'1'};
for(const purpose of ['TOTP','MAIL','FINANCE','SUSPICION','HR','DOCUMENT'])env[purpose+'_ENCRYPTION_KEY']=randomBytes(32).toString('base64');
env.AML_ENCRYPTION_KEY=Buffer.alloc(32,13).toString('base64');
for(const name of ['PREVIOUS_ENCRYPTION_KEYS','SANCTIONS_LIST_URL','COMPANIES_HOUSE_API_KEY','COMPANIES_HOUSE_API_URL'])delete env[name];
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{for(const child of children)child.kill();Promise.race([db.destroy(),sleep(3000)]).finally(()=>process.exit(130));});
try{
 const users=await db.selectFrom('accounts').innerJoin('account_roles','account_roles.account_id','accounts.id').select('accounts.id').where('account_roles.role','=','fee_earner').where('account_roles.revoked_at','is',null).where('accounts.kind','=','staff').where('accounts.status','=','active').execute();
 if(users.length!==100)throw new Error('Unexpected synthetic test fixture state');
 const actors=[];
 // Reuse synthetic fixture identities, with test-seeded sessions. MFA was measured
 // separately in the main run; this probe measures the shared IP boundary only.
 for(const user of users){const token=randomBytes(32).toString('base64url');await db.insertInto('sessions').values({account_id:user.id,token_hash:createHash('sha256').update(token).digest(),stage:'authenticated',authenticated_at:new Date(),last_seen_at:new Date(),expires_at:new Date(Date.now()+3600000),ip_address:'198.19.77.1',user_agent:'Synthetic NAT load probe'}).execute();actors.push({id:user.id,cookie:'__Host-session='+token});}
 const output=openSync(join(folder,'nat-api.log'),'w');child=spawn(process.execPath,[join(root,'apps/api/dist/main.js')],{cwd:root,env,windowsHide:true,stdio:['ignore',output,output]});closeSync(output);
 children.push(child);
 let ready=false;for(let i=0;i<30;i++){if(child.exitCode!==null)throw new Error('NAT test server exited');try{if((await fetch('http://127.0.0.1:3201/ready',{signal:AbortSignal.timeout(4000)})).ok){ready=true;break;}}catch{}await sleep(1000);}
 if(!ready)throw new Error('NAT test server unavailable');
 const secondOutput=openSync(join(folder,'nat-api-b.log'),'w');const second=spawn(process.execPath,[join(root,'apps/api/dist/main.js')],{cwd:root,env:{...env,PORT:'3203'},windowsHide:true,stdio:['ignore',secondOutput,secondOutput]});closeSync(secondOutput);children.push(second);
 let secondReady=false;for(let i=0;i<30;i++){if(second.exitCode!==null)throw new Error('Second test server exited');try{if((await fetch('http://127.0.0.1:3203/ready',{signal:AbortSignal.timeout(4000)})).ok){secondReady=true;break;}}catch{}await sleep(1000);}
 if(!secondReady)throw new Error('Second test server unavailable');
 const actor=actors[0],team=await db.selectFrom('matter_team').select('matter_id').where('account_id','=',actor.id).where('removed_at','is',null).executeTakeFirstOrThrow();
 const file=Buffer.alloc(1024*1024,66),form=new FormData();form.append('title','Cross replica synthetic document');form.append('category','other');form.append('file',new Blob([file],{type:'text/plain'}),'cross-replica.txt');
 const uploaded=await fetch(`http://127.0.0.1:3201/matters/${team.matter_id}/documents`,{method:'POST',headers:{cookie:actor.cookie,'x-forwarded-for':'198.19.77.2',origin:env.APP_BASE_URL,'sec-fetch-site':'same-origin'},body:form,signal:AbortSignal.timeout(15000)});
 if(uploaded.status!==201)throw new Error('Cross-replica upload failed: '+uploaded.status);
 const document=await uploaded.json(),downloaded=await fetch(`http://127.0.0.1:3203/documents/${document.id}/versions/1/content`,{headers:{cookie:actor.cookie,'x-forwarded-for':'198.19.77.2'},signal:AbortSignal.timeout(15000)});
 const crossReplicaDocumentVerified=downloaded.ok&&createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')===createHash('sha256').update(file).digest('hex');
 if(!crossReplicaDocumentVerified)throw new Error('Cross-replica document integrity failed');
 const left=60-(Math.floor(Date.now()/1000)%60);if(left<12)await sleep((left+1)*1000);
 const sharedIp=`198.19.${randomInt(2,250)}.${randomInt(1,250)}`,samples=[],started=Date.now();
 await Promise.all(actors.map(async(actor,index)=>{await sleep(index*2);for(let i=0;i<7;i++){
  const start=Date.now();try{const r=await fetch('http://127.0.0.1:3201/workspace/tasks',{headers:{cookie:actor.cookie,'x-forwarded-for':sharedIp},signal:AbortSignal.timeout(15000)});const body=await r.json();samples.push({status:r.status,valid:r.status===200&&body.items?.length===10,retry:r.headers.has('retry-after')});}catch{samples.push({status:0,valid:false});}
  await sleep(Math.max(0,1000-(Date.now()-start)));
 }}));
 const statuses={};for(const sample of samples)statuses[sample.status]=(statuses[sample.status]??0)+1;
 const report={scope:'100 synthetic authenticated staff share one IP; seven requests each over seven seconds',testSessionsSeeded:true,crossReplicaDocumentVerified,requests:samples.length,statuses,
  validBusinessResponses:samples.filter(s=>s.valid).length,throttled:samples.filter(s=>s.status===429).length,
  unexpectedServerErrors:samples.filter(s=>s.status===0||s.status>=500).length,durationSeconds:(Date.now()-started)/1000,
  anonymousIpLimit:600,authenticatedNetworkLimit:12000,accountLimit:300,windowSeconds:60,allThrottlesHaveRetryAfter:samples.filter(s=>s.status===429).every(s=>s.retry),
  interpretation:'Verified office users share the bounded network allowance while retaining individual account limits. Anonymous and recovery budgets are tested separately.'};
 writeFileSync(join(folder,'nat-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(report.validBusinessResponses!==700||report.throttled!==0||report.unexpectedServerErrors||!report.allThrottlesHaveRetryAfter)process.exitCode=1;
}catch(error){console.error('NAT probe stopped: '+(error instanceof Error?error.message:'test failure'));process.exitCode=1;}
finally{for(const child of children)child.kill();await db.destroy();}
