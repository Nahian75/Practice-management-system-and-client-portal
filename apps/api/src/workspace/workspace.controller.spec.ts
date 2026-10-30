import {randomUUID} from 'node:crypto';
import {Module} from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';
import type {Kysely} from 'kysely';
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
 afterAll(async()=>{await app.close();});
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
