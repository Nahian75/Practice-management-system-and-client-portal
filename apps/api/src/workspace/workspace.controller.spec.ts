import {randomUUID} from 'node:crypto';
import {Module} from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {sql,type Kysely} from 'kysely';
import request from 'supertest';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestApp} from '../../test/create-test-app.js';
import {createTestAccount,grantTestRole,type TestAccount} from '../../test/accounts.js';
import {DATABASE} from '../database/database.module.js';
import type {Database} from '../database/schema.js';
import {SessionsService} from '../auth/sessions/sessions.service.js';
import {AuditService} from '../audit/audit.service.js';
import {ClientsModule} from '../clients/clients.module.js';
import {MattersModule} from '../matters/matters.module.js';
import {TasksModule} from '../tasks/tasks.module.js';
import {WorkspaceModule} from './workspace.module.js';
import {FinanceModule} from '../finance/finance.module.js';
import {clearMatterForTests} from '../../test/aml.js';
@Module({imports:[ClientsModule,MattersModule,TasksModule,WorkspaceModule,FinanceModule]})class TestWorkspace{}
describe('Workspace access and calendar persistence',()=>{
 let app:NestExpressApplication,db:Kysely<Database>,sessions:SessionsService,owner:TestAccount,other:TestAccount,token:string,otherToken:string,matterId:string;
 const as=(t:string)=>{const server=request(app.getHttpServer());return {get:(path:string)=>server.get(path).set('Cookie',`__Host-session=${t}`),post:(path:string,body:object)=>server.post(path).set('Cookie',`__Host-session=${t}`).send(body),put:(path:string,body:object)=>server.put(path).set('Cookie',`__Host-session=${t}`).send(body)};};
 const appointment=(changes:object={})=>({title:'Client appointment',startsAt:'2027-04-02T10:00:00.000Z',endsAt:'2027-04-02T11:00:00.000Z',...changes});
 beforeAll(async()=>{app=await createTestApp(TestWorkspace);db=app.get(DATABASE);sessions=app.get(SessionsService);});
 afterAll(async()=>{await app?.close();});
 beforeEach(async()=>{
  owner=await createTestAccount(db,'staff');other=await createTestAccount(db,'staff');await grantTestRole(db,owner.id,'partner');await grantTestRole(db,other.id,'partner');
  token=await sessions.start(owner,'authenticated',{});otherToken=await sessions.start(other,'authenticated',{});
  const client=await as(token).post('/clients',{kind:'individual',givenNames:randomUUID().replaceAll('-',''),familyName:'Workspace'});expect(client.status).toBe(201);
  const check=await as(token).post('/conflict-checks',{clientId:client.body.id,names:[randomUUID().replaceAll('-','')]});
  const matter=await as(token).post('/matters',{clientId:client.body.id,title:'Workspace case',matterType:'other',supervisingPartnerId:owner.id,conflictCheckId:check.body.id});
  expect(matter.status).toBe(201);matterId=matter.body.id;
 });
 it('requires an authenticated staff role and rejects client sessions',async()=>{
  expect((await request(app.getHttpServer()).get('/workspace/tasks')).status).toBe(401);
  const client=await createTestAccount(db,'client');const clientToken=await sessions.start(client,'authenticated',{});
  expect((await as(clientToken).get('/workspace/events?from=2027-04-01&to=2027-04-30')).status).toBe(403);
  const admin=await createTestAccount(db,'staff');await grantTestRole(db,admin.id,'administrator');const adminToken=await sessions.start(admin,'authenticated',{});
  expect((await as(adminToken).get('/workspace/tasks')).status).toBe(403);
 });
 it('persists private timers, rejects forged worker ids and serializes concurrent device changes',async()=>{
  expect((await request(app.getHttpServer()).get('/workspace/timer')).status).toBe(401);
  const client=await createTestAccount(db,'client');const clientToken=await sessions.start(client,'authenticated',{});
  expect((await as(clientToken).get('/workspace/timer')).status).toBe(403);
  expect((await as(token).get('/workspace/timer')).body).toMatchObject({timerId:null,revision:null,elapsedMs:0,startedAt:null});
  expect((await as(token).post('/workspace/timer',{action:'start',revision:null,accountId:other.id})).status).toBe(400);
  const results=await Promise.all([as(token).post('/workspace/timer',{action:'start',revision:null}),as(token).post('/workspace/timer',{action:'start',revision:null})]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  const started=results.find(r=>r.status===201)!.body;
  expect((await as(token).get('/workspace/timer')).body).toMatchObject({timerId:started.timerId,revision:started.revision});
  expect((await as(otherToken).get('/workspace/timer')).body.timerId).toBeNull();
  expect((await as(otherToken).post('/workspace/timer',{action:'pause',revision:started.revision})).status).toBe(409);
  // Simulate 75 seconds without a browser tick: the backend uses timestamps.
  await sql`UPDATE app.work_timers SET started_at=clock_timestamp()-interval '75 seconds' WHERE account_id=${owner.id}::uuid`.execute(db);
  const paused=await as(token).post('/workspace/timer',{action:'pause',revision:started.revision});expect(paused.status).toBe(201);
  expect(paused.body.startedAt).toBeNull();expect(paused.body.elapsedMs).toBeGreaterThanOrEqual(75000);
  const resumed=await as(token).post('/workspace/timer',{action:'start',revision:paused.body.revision});expect(resumed.status).toBe(201);
  expect(resumed.body.timerId).toBe(started.timerId);expect(resumed.body.elapsedMs).toBe(paused.body.elapsedMs);expect(resumed.body.startedAt).not.toBeNull();
  const pausedAgain=await as(token).post('/workspace/timer',{action:'pause',revision:resumed.body.revision});expect(pausedAgain.status).toBe(201);
  expect(pausedAgain.body.elapsedMs).toBeGreaterThanOrEqual(paused.body.elapsedMs);
  expect((await as(token).post('/workspace/timer',{action:'reset',revision:started.revision})).status).toBe(409);
  const reset=await as(token).post('/workspace/timer',{action:'reset',revision:pausedAgain.body.revision});expect(reset.status).toBe(201);
  expect(reset.body).toMatchObject({elapsedMs:0,startedAt:null});expect(reset.body.timerId).not.toBe(started.timerId);
 });
 it('consumes one paused timer once across concurrent saves and safely replays an uncertain save',async()=>{
  await grantTestRole(db,owner.id,'accounts');await clearMatterForTests(db,matterId);
  const today=(await as(token).get('/workspace/performance')).body.asOf;
  expect((await as(token).post('/finance/rates',{accountId:owner.id,hourlyRate:'120.00',effectiveFrom:today})).status).toBe(201);
  const started=await as(token).post('/workspace/timer',{action:'start',revision:null});
  const paused=await as(token).post('/workspace/timer',{action:'pause',revision:started.body.revision});
  const body={timerId:paused.body.timerId,revision:paused.body.revision,matterId,workedOn:today,minutes:1,description:'Reviewed timed instructions'};
  const responses=await Promise.all([as(token).post('/workspace/timer/record',body),as(token).post('/workspace/timer/record',body)]);
  expect(responses.map(r=>r.status)).toEqual([201,201]);expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
  const rows=await db.selectFrom('time_entries').select('id').where('worker_id','=',owner.id).execute();expect(rows).toHaveLength(1);
  expect((await as(token).get('/workspace/timer')).body).toMatchObject({elapsedMs:0,startedAt:null});
  expect((await as(token).post('/workspace/timer/record',{...body,minutes:2})).status).toBe(409);
  expect((await as(otherToken).post('/workspace/timer/record',body)).status).toBe(404);
  const events=await db.selectFrom('audit_events').select('id').where('resource_id','=',rows[0]!.id).where('action','=','time.recorded').execute();expect(events).toHaveLength(1);
 });
 it('keeps the timer when saving work fails clearance or auditing and refuses stale handoffs',async()=>{
  const started=await as(token).post('/workspace/timer',{action:'start',revision:null});
  const today=(await as(token).get('/workspace/performance')).body.asOf;
  const body={timerId:started.body.timerId,revision:started.body.revision,matterId,workedOn:today,minutes:1,description:'A timer cannot bypass clearance'};
  expect((await as(token).post('/workspace/timer/record',body)).status).toBe(409);
  const paused=await as(token).post('/workspace/timer',{action:'pause',revision:started.body.revision});
  body.revision=paused.body.revision;
  expect((await as(token).post('/workspace/timer/record',body)).status).toBe(409);
  expect((await as(token).get('/workspace/timer')).body.revision).toBe(paused.body.revision);
  await grantTestRole(db,owner.id,'accounts');await clearMatterForTests(db,matterId);
  expect((await as(token).post('/finance/rates',{accountId:owner.id,hourlyRate:'120.00',effectiveFrom:today})).status).toBe(201);
  const audit=app.get(AuditService),original=audit.record.bind(audit);
  const mocked=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action==='time.recorded'?Promise.reject(new Error('audit unavailable')):original(event,trx));
  try{expect((await as(token).post('/workspace/timer/record',body)).status).toBe(500);}finally{mocked.mockRestore();}
  expect((await as(token).get('/workspace/timer')).body.revision).toBe(paused.body.revision);
  expect(await db.selectFrom('time_entries').select('id').where('worker_id','=',owner.id).execute()).toHaveLength(0);
  const receipts=await sql`SELECT timer_id FROM app.work_timer_receipts WHERE account_id=${owner.id}::uuid`.execute(db);expect(receipts.rows).toHaveLength(0);
  const reset=await as(token).post('/workspace/timer',{action:'reset',revision:paused.body.revision});expect(reset.status).toBe(201);
  expect((await as(token).post('/workspace/timer/record',body)).status).toBe(409);
 });
 it('rolls back a timer change if its audit cannot be written',async()=>{
  const audit=app.get(AuditService),original=audit.record.bind(audit);
  const mocked=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action==='timer.start'?Promise.reject(new Error('audit unavailable')):original(event,trx));
  try{expect((await as(token).post('/workspace/timer',{action:'start',revision:null})).status).toBe(500);}finally{mocked.mockRestore();}
  expect((await as(token).get('/workspace/timer')).body.timerId).toBeNull();
 });
 it('preserves sessions longer than one day instead of silently truncating their time',async()=>{
  const started=await as(token).post('/workspace/timer',{action:'start',revision:null});
  const paused=await as(token).post('/workspace/timer',{action:'pause',revision:started.body.revision});
  await sql`UPDATE app.work_timers SET elapsed_ms=86400001 WHERE account_id=${owner.id}::uuid`.execute(db);
  const today=(await as(token).get('/workspace/performance')).body.asOf;
  const result=await as(token).post('/workspace/timer/record',{timerId:paused.body.timerId,revision:paused.body.revision,matterId,workedOn:today,minutes:1440,description:'A long session must be split across daily entries'});
  expect(result.status).toBe(409);expect(result.body.message).toContain('separate daily entries');
  expect((await as(token).get('/workspace/timer')).body.elapsedMs).toBe(86400001);
 });
 it('lists, filters and searches tasks only on current matter teams',async()=>{
  const task=await as(token).post(`/matters/${matterId}/tasks`,{title:'Review workspace contract',assigneeId:owner.id,dueOn:'2027-04-02',priority:'high'});expect(task.status).toBe(201);
  const own=await as(token).get('/workspace/tasks?q=workspace&assignee=me&from=2027-04-01&to=2027-04-30');expect(own.status).toBe(200);expect(own.body.items.map((t:{id:string})=>t.id)).toEqual([task.body.id]);
  expect((await as(otherToken).get('/workspace/tasks?q=workspace')).body.items).toEqual([]);
  const found=await as(otherToken).get('/workspace/search?q=Workspace');expect(found.body.matters).toEqual([]);expect(found.body.clients).toEqual([]);
  const visible=await as(token).get('/workspace/search?q=Workspace');expect(visible.body.matters.map((m:{id:string})=>m.id)).toContain(matterId);
 });
 it('returns valid document and activity pages without broadening access',async()=>{
  for(const endpoint of ['documents','activities']){const response=await as(token).get(`/workspace/${endpoint}`);expect(response.status).toBe(200);expect(response.body).toEqual({items:[],next:null});}
 });
 it('persists private appointments and only lets their owner cancel them',async()=>{
  const created=await as(token).post('/workspace/events',appointment({matterId}));expect(created.status).toBe(201);
  const own=await as(token).get('/workspace/events?from=2027-04-01&to=2027-04-30');expect(own.status).toBe(200);expect(own.body.events[0].id).toBe(created.body.id);
  expect((await as(otherToken).get('/workspace/events?from=2027-04-01&to=2027-04-30')).body.events).toEqual([]);
  expect((await as(otherToken).post(`/workspace/events/${created.body.id}/cancel`,{})).status).toBe(404);
  expect((await as(token).post(`/workspace/events/${created.body.id}/cancel`,{})).status).toBe(204);
  expect((await as(token).get('/workspace/events?from=2027-04-01&to=2027-04-30')).body.events).toEqual([]);
  expect((await as(token).post(`/workspace/events/${created.body.id}/cancel`,{})).status).toBe(409);
 });
 it('refuses inaccessible matter associations and invalid date ranges',async()=>{
  expect((await as(otherToken).post('/workspace/events',appointment({matterId}))).status).toBe(404);
  expect((await as(token).post('/workspace/events',appointment({endsAt:'2027-04-02T09:00:00.000Z'}))).status).toBe(400);
  expect((await as(token).get('/workspace/events?from=2027-01-01&to=2028-01-01')).status).toBe(400);
 });
 it('rolls back event creation if its audit record cannot be saved',async()=>{
  const audit=app.get(AuditService),original=audit.record.bind(audit);
  const mocked=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action==='calendar.created'?Promise.reject(new Error('audit unavailable')):original(event,trx));
  try{expect((await as(token).post('/workspace/events',appointment())).status).toBe(500);expect((await as(token).get('/workspace/events?from=2027-04-01&to=2027-04-30')).body.events).toEqual([]);}finally{mocked.mockRestore();}
 });
 it('keeps performance targets private and rolls back a failed audited update',async()=>{
  expect((await as(token).put('/workspace/performance-target',{dailyTargetMinutes:114})).status).toBe(204);
  expect((await as(token).get('/workspace/performance')).body.dailyTargetMinutes).toBe(114);
  expect((await as(otherToken).get('/workspace/performance')).body.dailyTargetMinutes).toBeNull();
  expect((await as(token).put('/workspace/performance-target',{dailyTargetMinutes:1})).status).toBe(400);
  const audit=app.get(AuditService),original=audit.record.bind(audit);const mocked=vi.spyOn(audit,'record').mockImplementation((event,trx)=>event.action==='performance.target_changed'?Promise.reject(new Error('audit unavailable')):original(event,trx));
  try{expect((await as(token).put('/workspace/performance-target',{dailyTargetMinutes:360})).status).toBe(500);expect((await as(token).get('/workspace/performance')).body.dailyTargetMinutes).toBe(114);}finally{mocked.mockRestore();}
 });
 it('aggregates actual own time, excludes voids and protects firm financial data',async()=>{
  expect((await as(token).get('/workspace/firm-performance')).status).toBe(403);
  expect((await as(token).get('/workspace/billing-metrics')).status).toBe(403);
  await grantTestRole(db,owner.id,'accounts');await clearMatterForTests(db,matterId);
  const metrics=await as(token).get('/workspace/performance');expect(metrics.status).toBe(200);const today=metrics.body.asOf;
  expect((await as(token).post('/finance/rates',{accountId:owner.id,hourlyRate:'120.00',effectiveFrom:today})).status).toBe(201);
  const entry=await as(token).post(`/matters/${matterId}/time-entries`,{workedOn:today,minutes:90,description:'Reviewing a draft agreement'});expect(entry.status).toBe(201);
  const own=await as(token).get('/workspace/performance');expect(own.body.periods[0]).toMatchObject({minutes:90,unbilledPence:'18000',billedPence:'0'});
  expect((await as(otherToken).get('/workspace/performance')).body.periods[0].minutes).toBe(0);
  expect((await as(token).get('/workspace/firm-performance')).status).toBe(200);
  expect((await as(token).post(`/time-entries/${entry.body.id}/corrections`,{replacement:null,reason:'Duplicate entry removed during this isolated test.'})).status).toBe(200);
  expect((await as(token).get('/workspace/performance')).body.periods[0]).toMatchObject({minutes:0,unbilledPence:'0'});
 });
 it('uses the same draft gross amounts as billing and restricts the audit feed',async()=>{
  await grantTestRole(db,owner.id,'accounts');await clearMatterForTests(db,matterId);
  const before=await as(token).get('/workspace/billing-metrics');expect(before.status).toBe(200);const today=(await as(token).get('/workspace/performance')).body.asOf;
  const draft=await as(token).post(`/matters/${matterId}/bill-drafts`,{taxPoint:today,dueOn:today,supplier:{name:'Test Firm',addressLine1:'1 Example Road',addressLine2:null,town:'London',postcode:'SW1A 1AA',country:'GB',vatRegistrationNumber:'GB123456789'},lines:[{kind:'fee',description:'Review work',net:'100.03',vatTreatment:'standard',timeEntryId:null}]});expect(draft.status).toBe(201);
  const after=await as(token).get('/workspace/billing-metrics');expect(after.body.draftCount).toBe(before.body.draftCount+1);expect(BigInt(after.body.draftPence)-BigInt(before.body.draftPence)).toBe(12004n);
  const records=await as(token).get('/workspace/billing-records?kind=draft');expect(records.status).toBe(200);expect(records.body.items.find((item:{id:string})=>item.id===draft.body.id)).toMatchObject({grossPence:'12004',matterId});
  expect((await as(otherToken).get('/workspace/billing-records?kind=draft')).status).toBe(403);
  expect((await as(token).get('/workspace/billing-records?kind=issued')).status).toBe(200);expect((await as(token).get('/workspace/billing-records?kind=credit')).status).toBe(200);
  expect((await as(token).get('/workspace/feed')).status).toBe(403);await grantTestRole(db,owner.id,'compliance');const feed=await as(token).get('/workspace/feed');expect(feed.status).toBe(200);expect(Object.keys(feed.body.events[0]).sort()).toEqual(['action','id','occurredAt','outcome']);
 });
});
