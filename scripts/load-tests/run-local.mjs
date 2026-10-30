// Bounded, synthetic-only local performance exercise. Never accepts remote URLs.
import 'reflect-metadata';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connect} from 'node:net';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import ts from 'typescript';
import {createDatabase} from '../../apps/api/dist/database/database.js';
import {PasswordHasher} from '../../apps/api/dist/auth/passwords/password-hasher.js';
import {SecretBox} from '../../apps/api/dist/common/crypto/secret-box.js';
import {hotp,timeStep} from '../../apps/api/dist/auth/two-factor/totp.js';

const root=resolve(import.meta.dirname,'../..'),replicas=process.argv.includes('--replicas=2')?2:1,api=replicas===2?'http://127.0.0.1:3205':'http://127.0.0.1:3201',web='http://127.0.0.1:3200';
process.loadEnvFile(join(root,'apps/api/.env'));
function isolated(value){const u=new URL(value??'');if(!['127.0.0.1','localhost'].includes(u.hostname))throw new Error('Only local test database connections are allowed');u.pathname='/pms_e2e';return u.href;}
const database=isolated(process.env.TEST_DATABASE_URL),owner=isolated(process.env.TEST_MIGRATION_DATABASE_URL);
for(const name of ['SMTP_URL','DOCUMENTS_S3_ENDPOINT'])if(!['localhost','127.0.0.1'].includes(new URL(process.env[name]??'').hostname))throw new Error('Only local mail/storage test services are allowed');
const runId=new Date().toISOString().replaceAll(':','-'),folder=join(root,'logs/load-tests',runId);
mkdirSync(folder,{recursive:true});
const results=[],children=[],actors=[];let db;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
 for(const child of children)child.kill();
 Promise.race([db?.destroy(),sleep(3000)]).finally(()=>process.exit(signal==='SIGINT'?130:143));
});
const env={...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'3201',DATABASE_URL:database,
 TEST_DATABASE_URL:database,TEST_MIGRATION_DATABASE_URL:owner,APP_BASE_URL:web,TRUSTED_PROXIES:'loopback',LOG_LEVEL:'error',
 DOCUMENTS_S3_BUCKET:'pms-documents-e2e',DOCUMENTS_S3_ENDPOINT:'http://127.0.0.1:8333',CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:'3310',
 PMS_LOAD_TEST:'1',ENCRYPTION_KEY_VERSION:'1',DATABASE_POOL_MAX:'5',DATABASE_REPLICA_LIMIT:'3',DATABASE_CONNECTION_BUDGET:'100',DATABASE_RESERVED_CONNECTIONS:'20'};
for(const purpose of ['TOTP','MAIL','FINANCE','SUSPICION','HR','DOCUMENT'])env[purpose+'_ENCRYPTION_KEY']=randomBytes(32).toString('base64');
// Matches the existing synthetic AML fixture cipher, never a production key.
env.AML_ENCRYPTION_KEY=Buffer.alloc(32,13).toString('base64');
for(const name of ['PREVIOUS_ENCRYPTION_KEYS','SANCTIONS_LIST_URL','COMPANIES_HOUSE_API_KEY','COMPANIES_HOUSE_API_URL'])delete env[name];
function execute(args,options={}){const r=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:4*1024*1024,...options});if(r.status!==0)throw new Error('Test preparation command failed');return r.stdout;}
async function freePort(port){return new Promise(resolve=>{const s=connect({port,host:'127.0.0.1'});s.setTimeout(1000);s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',()=>resolve(true));s.once('timeout',()=>{s.destroy();resolve(false);});});}
function launch(name,args,extra){
 const out=openSync(join(folder,name+'.log'),'w');
 const child=spawn(process.execPath,['--import',pathToFileURL(join(root,'scripts/load-tests/monitor.mjs')).href,...args],{
  cwd:root,windowsHide:true,env:{...env,PMS_LOAD_METRICS:join(folder,name+'-resources.jsonl'),...extra},stdio:['ignore',out,out]});
 closeSync(out);children.push(child);return child;
}
async function waitFor(url){for(let i=0;i<90;i++){if(children.some(child=>child.exitCode!==null))throw new Error('A test server exited during startup; inspect private test logs');try{const r=await fetch(url,{signal:AbortSignal.timeout(4000)});if(r.ok)return;}catch{}await sleep(1000);}throw new Error('Isolated test server did not become ready');}
const headers=actor=>({'x-forwarded-for':actor.ip,origin:web,'sec-fetch-site':'same-origin',...(actor.cookie?{cookie:actor.cookie}:{})});
async function call(actor,path,{method='GET',data,form,origin=api}={}){
 const started=performance.now();
 try{
  const r=await fetch(origin+path,{method,headers:{...headers(actor),...(data?{'content-type':'application/json'}:{})},
   body:form??(data?JSON.stringify(data):undefined),signal:AbortSignal.timeout(15000),redirect:'manual'});
  const text=await r.text();let body;try{body=JSON.parse(text);}catch{}
  return {status:r.status,ms:performance.now()-started,body,text,cookies:r.headers.getSetCookie(),retryAfter:r.headers.get('retry-after')};
 }catch{return {status:0,ms:performance.now()-started};}
}
function requireStatus(r,status,label){if(r.status!==status)throw new Error(`${label}: expected ${status}, got ${r.status}`);return r.body;}
async function parallel(items,concurrency,work){let cursor=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{for(;;){const i=cursor++;if(i>=items.length)return;await work(items[i],i);}}));}
function summary(name,samples,started,ended){
 const times=samples.map(s=>s.ms).sort((a,b)=>a-b),statuses={};for(const s of samples)statuses[s.status]=(statuses[s.status]??0)+1;
 const percentile=p=>Number((times[Math.max(0,Math.ceil(times.length*p)-1)]??0).toFixed(1));
 const expected=samples.filter(s=>s.valid).length;
 const r={name,requests:samples.length,durationSeconds:Number(((ended-started)/1000).toFixed(2)),requestsPerSecond:Number((samples.length/((ended-started)/1000)).toFixed(2)),
  p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:percentile(1),statuses,validResponses:expected,invalidResponses:samples.length-expected,
  passed:samples.length>0&&expected===samples.length&&percentile(.95)<2000,startedAt:started,endedAt:ended};
 results.push(r);console.log(JSON.stringify(r));writeFileSync(join(folder,'progress.json'),JSON.stringify(results,null,2));return r;
}
let workload;
async function phase(name,count,seconds,thinkMs,maxIterations=100000){
 const samples=[],start=Date.now(),deadline=start+seconds*1000;
 await Promise.all(actors.slice(0,count).map(async(actor,i)=>{
  await sleep(i*3);
  for(let n=0;n<maxIterations&&Date.now()<deadline;n++){
   const tick=Date.now(),op=(n+i)%8;
   const selected=workload(actor,op,n),r=await call(actor,selected.path,selected.options);
   samples.push({...r,body:undefined,text:undefined,cookies:undefined,valid:r.status===selected.status&&selected.validate(r)});
   if(r.status>=500||r.status===0){if(samples.filter(s=>s.status===0||s.status>=500).length>=20)break;}
   if(thinkMs)await sleep(Math.max(0,thinkMs-(Date.now()-tick)));
  }
 }));return summary(name,samples,start,Date.now());
}
try{
 for(const port of replicas===2?[3200,3201,3203,3205]:[3200,3201])if(!(await freePort(port)))throw new Error('Load-test ports are already in use');
 console.log('Preparing only the disposable local pms_e2e database.');
 execute(['apps/web/e2e/prepare-database.mjs']);
 db=createDatabase(owner,4);
 const fixtureFolder=join(folder,'fixtures');mkdirSync(fixtureFolder);
 writeFileSync(join(fixtureFolder,'package.json'),JSON.stringify({type:'module'}));
 // Reuse protected business-rule fixture helpers; no trigger or permission is disabled.
 for(const name of ['accounts','database','sanctions','aml']){
  const source=readFileSync(join(root,'apps/api/test',name+'.ts'),'utf8');
  let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replace(/(['"])\.\.\/src\/([^'"]+)\1/g,(_m,_quote,file)=>JSON.stringify(pathToFileURL(join(root,'apps/api/dist',file)).href));
  writeFileSync(join(fixtureFolder,name+'.js'),code);
 }
 const savedTest=process.env.TEST_DATABASE_URL;process.env.TEST_DATABASE_URL=database;
 const {createTestAccount,grantTestRole}=await import(pathToFileURL(join(fixtureFolder,'accounts.js')).href);
 const {createTeamMatter,clearMatterForTests}=await import(pathToFileURL(join(fixtureFolder,'aml.js')).href);
 if(savedTest===undefined)delete process.env.TEST_DATABASE_URL;else process.env.TEST_DATABASE_URL=savedTest;
 const password=randomBytes(24).toString('base64url'),hash=await new PasswordHasher().hash(password),box=new SecretBox(Buffer.from(env.TOTP_ENCRYPTION_KEY,'base64'),1);
 const supervisor=await createTestAccount(db,'staff',{passwordHash:hash});await grantTestRole(db,supervisor.id,'partner');
 for(let i=0;i<100;i++){
  const user=await createTestAccount(db,'staff',{passwordHash:hash});await grantTestRole(db,user.id,'fee_earner');
  const secret=randomBytes(20),sealed=box.seal(secret,user.id);
  await db.insertInto('totp_credentials').values({account_id:user.id,key_version:sealed.keyVersion,nonce:sealed.nonce,ciphertext:sealed.ciphertext,auth_tag:sealed.authTag,created_at:new Date(),confirmed_at:new Date(),last_used_step:null}).execute();
  await db.transaction().execute(async trx=>{for(let c=0;c<20;c++){
   const client=await trx.insertInto('clients').values({kind:'individual',created_by:user.id}).returning('id').executeTakeFirstOrThrow();
   await trx.insertInto('client_individuals').values({client_id:client.id,given_names:'Loadtest',family_name:`Person ${i} ${c}`}).execute();
  }});
  const {matterId,clientId}=await createTeamMatter(db,user,supervisor);await clearMatterForTests(db,matterId);
  actors.push({...user,ip:`198.18.1.${i+1}`,secret,matterId,clientId});
  if((i+1)%25===0)console.log('Prepared synthetic staff/matter fixtures: '+(i+1));
 }
 let apiChild=launch('api',[join(root,'apps/api/dist/main.js')]);await waitFor('http://127.0.0.1:3201/ready');
 if(replicas===2){
  launch('api-b',[join(root,'apps/api/dist/main.js')],{PORT:'3203'});await waitFor('http://127.0.0.1:3203/ready');
  launch('balancer',[join(root,'scripts/load-tests/local-balancer.mjs')]);await waitFor(api+'/ready');
 }
 launch('web',[join(root,'node_modules/next/dist/bin/next'),'start','apps/web','--hostname','127.0.0.1','--port','3200'],{NODE_ENV:'production',API_URL:api,APP_NAME:'Stass load test'});
 await waitFor(web+'/sign-in');
 const loginSamples=[],loginStart=Date.now();
 await parallel(actors,10,async actor=>{
  const first=await call(actor,'/auth/sign-in',{method:'POST',data:{email:actor.email,password}});requireStatus(first,200,'Password sign-in');
  actor.cookie=first.cookies.find(c=>c.startsWith('__Host-session='))?.split(';')[0];
  const second=await call(actor,'/auth/two-factor',{method:'POST',data:{code:hotp(actor.secret,timeStep(new Date()))}});
  const signedIn=requireStatus(second,200,'MFA sign-in');if(signedIn.account.id!==actor.id)throw new Error('Incorrect signed-in identity');
  actor.cookie=second.cookies.find(c=>c.startsWith('__Host-session='))?.split(';')[0];if(!actor.cookie)throw new Error('No authenticated session');
  loginSamples.push({ms:first.ms+second.ms,status:200,valid:true});
 });summary('100 real password + MFA logins (10 concurrent)',loginSamples,loginStart,Date.now());
 await parallel(actors,5,async actor=>{for(let i=0;i<10;i++){
  requireStatus(await call(actor,`/matters/${actor.matterId}/tasks`,{method:'POST',data:{title:`Load task ${i}`,assigneeId:actor.id,dueOn:'2027-04-02',priority:'normal'}}),201,'Task fixture');
  requireStatus(await call(actor,'/workspace/events',{method:'POST',data:{title:`Load event ${i}`,startsAt:'2027-04-02T10:00:00.000Z',endsAt:'2027-04-02T10:30:00.000Z'}}),201,'Calendar fixture');
 }});
 const counts={};for(const table of ['accounts','clients','matters','tasks','calendar_events']){const row=await db.selectFrom(table).select(eb=>eb.fn.countAll().as('count')).executeTakeFirstOrThrow();counts[table]=Number(row.count);}
 console.log('Synthetic dataset: '+JSON.stringify(counts));
 workload=(actor,op,n)=>[
  {path:'/auth/session',status:200,validate:r=>r.body?.account?.id===actor.id},
  {path:'/clients',status:200,validate:r=>r.body?.clients?.length>=20},
  {path:'/matters',status:200,validate:r=>r.body?.matters?.some(m=>m.id===actor.matterId)},
  {path:'/workspace/tasks',status:200,validate:r=>r.body?.items?.length===10&&r.body.items.every(t=>t.assigneeId===actor.id)},
  {path:'/workspace/events?from=2027-04-01&to=2027-04-30',status:200,validate:r=>r.body?.events?.length>=10},
  {path:'/workspace/search?q=Loadtest',status:200,validate:r=>r.body?.clients?.length===20},
  {path:'/workspace/performance',status:200,validate:r=>r.body?.periods?.length===4},
  {path:'/workspace/events',options:{method:'POST',data:{title:`Load measured ${n}`,startsAt:'2027-04-02T11:00:00.000Z',endsAt:'2027-04-02T11:30:00.000Z'}},status:201,validate:r=>typeof r.body?.id==='string'},
 ][op];
 await phase('10 active users, one request/user/second',10,15,1000);
 await phase('25 active users, one request/user/second',25,30,1000);
 await phase('50 active users, one request/user/second',50,30,1000);
 await phase('100 active users, one request/user/second',100,60,1000);
 await phase('100 concurrent API callers, bounded unpaced burst',100,30,0,20);
 let replacementVerified=false,crashVerified=false,balancerStats;
 if(replicas===2){
  const replace=(async()=>{
   await sleep(4000);
   await fetch(api+'/_load/drain?port=3201',{method:'POST'});
   for(let i=0;i<100;i++){const s=await(await fetch(api+'/_load/stats')).json();if(s.backends.find(b=>b.port===3201).active===0)break;await sleep(100);}
   const exited=new Promise(resolve=>apiChild.once('exit',resolve));apiChild.kill();await exited;
   await sleep(2000);apiChild=launch('api-replacement',[join(root,'apps/api/dist/main.js')]);
   // waitFor normally rejects terminated children; replacement intentionally has one.
   for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:3201/ready',{signal:AbortSignal.timeout(1000)})).ok){replacementVerified=true;break;}}catch{}await sleep(1000);}
   await fetch(api+'/_load/restore?port=3201',{method:'POST'});
  })();
  await phase('100 active users during drained API replacement',100,20,1000);await replace;
  const original=workload;workload=(a,op,n)=>original(a,op===7?3:op,n);
  const crash=(async()=>{await sleep(3000);const exited=new Promise(resolve=>apiChild.once('exit',resolve));apiChild.kill('SIGKILL');await exited;crashVerified=true;})();
  await phase('100 read-only callers during abrupt API loss (fixture GET retries)',100,12,1000);await crash;
  workload=original;balancerStats=await(await fetch(api+'/_load/stats')).json();
 }
 const oldWorkload=workload;workload=()=>({path:'/',options:{origin:web},status:200,validate:r=>r.text?.includes('Personal Dashboard')&&r.text.includes('Stass load test')});
 await phase('25 concurrent server-rendered dashboards',25,30,5000,6);
 workload=oldWorkload;
 const file=Buffer.alloc(1024*1024,65),fileHash=createHash('sha256').update(file).digest('hex'),uploads=[],uploadStart=Date.now();
 await parallel(actors.slice(0,20),10,async(actor,i)=>{
  const form=new FormData();form.append('title','Synthetic load document');form.append('category','other');form.append('file',new Blob([file],{type:'text/plain'}),`load-${i}.txt`);
  const r=await call(actor,`/matters/${actor.matterId}/documents`,{method:'POST',form});
  let valid=r.status===201;
  if(valid){const download=await fetch(api+`/documents/${r.body.id}/versions/1/content`,{headers:headers(actor),signal:AbortSignal.timeout(15000)});valid=download.ok&&createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex')===fileHash;}
  uploads.push({ms:r.ms,status:r.status,valid});
 });summary('20 x 1 MiB scanned/encrypted uploads, concurrency 10; downloads hash-verified',uploads,uploadStart,Date.now());
 const probe={ip:'198.19.255.254'},probeStatuses=[];
 for(let i=0;i<21;i++)probeStatuses.push(await call(probe,'/auth/password-reset/request',{method:'POST',data:{email:'load-absent@example.test'}}));
 const abusePassed=probeStatuses.slice(0,20).every(r=>r.status===204)&&probeStatuses[20].status===429&&Number(probeStatuses[20].retryAfter)>0;
 const inaccessible=await call(actors[0],`/matters/${actors[1].matterId}`),authorizationPassed=inaccessible.status===404;
 const resource={};for(const name of replicas===2?['api','api-b','api-replacement','web']:['api','web']){const samples=readFileSync(join(folder,name+'-resources.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);resource[name]={samples:samples.length,maxRssMiB:Math.round(Math.max(...samples.map(s=>s.rssMiB))),maxCpuPercentOneCore:Math.round(Math.max(...samples.map(s=>s.cpuPercentOneCore))),maxEventLoopP95Ms:Math.round(Math.max(...samples.map(s=>s.eventLoopP95Ms)))};}
 if(replicas===2)balancerStats=await(await fetch(api+'/_load/stats')).json();
 const report={date:runId,scope:'isolated local pms_e2e, synthetic staff, production builds; app/database/generator share hardware',gitCommit:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
  environment:{node:process.version,cpu:os.cpus()[0]?.model,logicalCpuCount:os.cpus().length,hostMemoryGiB:Number((os.totalmem()/1024**3).toFixed(1)),apiPoolMax:5,replicas},virtualUsers:100,counts,results,resource,
  replicaReplacementVerified:replacementVerified,abruptReplicaLossExercised:crashVerified,balancerStats,
  balancerSemantics:replicas===2?'Local fixture probes at 250 ms and retries GET/HEAD only before sending response headers; not AWS ALB timing or retry guarantees':'No balancer',
  abuseLimitEnforced:abusePassed,crossUserMatterDenied:authorizationPassed,criticalDependenciesReady:(await fetch(api+'/ready')).ok,
  limitations:['Short local exercise, not AWS capacity certification','Closed-loop clients; slow responses reduce offered load','Only 25 concurrent SSR dashboards; no browser JS/render timing','No long soak, actual cloud autoscaling, RDS failover, billing ledger load or external network latency','Main profiles use separate synthetic IPs; office-NAT is a separate probe','Setup uses protected fixture functions; actual password/MFA login is exercised','Rate limits remain enabled; throttled requests are reported separately from server errors']};
 writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2));
 writeFileSync(join(root,'logs/load-tests/latest-report-path.txt'),join(folder,'report.json'));
 if(!abusePassed||!authorizationPassed||results.some(r=>!r.passed)||(replicas===2&&(!replacementVerified||!crashVerified)))process.exitCode=1;
 console.log('Completed local load test. Sanitized report: '+join(folder,'report.json'));
}catch(error){console.error('Local load test stopped: '+(error instanceof Error?error.message:'setup failure'));process.exitCode=1;}
finally{for(const child of children)child.kill();await db?.destroy();}
