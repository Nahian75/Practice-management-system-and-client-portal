import { createHash, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { testOwnerDatabaseUrl } from '../../test/database.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { createDatabase } from '../database/database.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { HrModule } from './hr.module.js';

@Module({imports:[HrModule]}) class HrCompetenceTestModule {}
const pattern={timeZone:'Europe/London',mondayMinutes:450,tuesdayMinutes:450,wednesdayMinutes:450,
  thursdayMinutes:450,fridayMinutes:420,saturdayMinutes:0,sundayMinutes:0};

describe('People / HR competence and review API',()=>{
  let app:NestExpressApplication,db:Kysely<Database>,ownerDb:Kysely<Database>,sessions:SessionsService;
  let hr:TestAccount,worker:TestAccount,manager:TestAccount,outsider:TestAccount;
  let hrToken:string,workerToken:string,managerToken:string,outsiderToken:string;
  let workerPerson:string,managerPerson:string,today:string,tomorrow:string;
  const api=(token:string)=>{const server=request(app.getHttpServer()),cookie=`__Host-session=${token}`;return{
    get:(path:string)=>server.get(path).set('Cookie',cookie),post:(path:string,body:object)=>server.post(path).set('Cookie',cookie).send(body)};};
  async function staffWith(...roles:StaffRole[]){const account=await createTestAccount(db,'staff');
    for(const role of roles)await grantTestRole(db,account.id,role);return account;}
  async function createPerson(account:TestAccount){const response=await api(hrToken).post('/hr/people',{accountId:account.id});
    expect(response.status,JSON.stringify(response.body)).toBe(201);return response.body.personId as string;}
  async function engage(personId:string,title:string){const response=await api(hrToken).post(`/hr/people/${personId}/engagements`,{
    kind:'employee',startedOn:today,jobTitle:title,team:'Disputes',workLocation:'London',pattern});
    expect(response.status,JSON.stringify(response.body)).toBe(201);}
  async function cycle(){const response=await api(workerToken).post('/hr/me/development',{
    title:'Annual competence cycle',periodStart:today,periodEnd:'2099-12-31'});
    expect(response.status,JSON.stringify(response.body)).toBe(201);return response.body.id as string;}

  beforeAll(async()=>{app=await createTestApp(HrCompetenceTestModule);db=app.get(DATABASE);
    ownerDb=createDatabase<Database>(testOwnerDatabaseUrl(),1);sessions=app.get(SessionsService);
    const dates=(await sql<{today:string;tomorrow:string}>`select current_date::text today,(current_date+1)::text tomorrow`.execute(db)).rows[0]!;
    ({today,tomorrow}=dates);});
  afterAll(async()=>{await ownerDb.destroy();await app.close();});
  beforeEach(async()=>{hr=await staffWith('hr');worker=await staffWith('fee_earner');manager=await staffWith('partner');
    outsider=await staffWith('partner');[hrToken,workerToken,managerToken,outsiderToken]=await Promise.all([
      sessions.start(hr,'authenticated',{}),sessions.start(worker,'authenticated',{}),sessions.start(manager,'authenticated',{}),
      sessions.start(outsider,'authenticated',{})]);workerPerson=await createPerson(worker);managerPerson=await createPerson(manager);
    await engage(workerPerson,'Solicitor');await engage(managerPerson,'Partner');expect((await api(hrToken)
      .post(`/hr/people/${workerPerson}/manager`,{managerPersonId:managerPerson,effectiveOn:today})).status).toBe(201);});

  it('limits competence records to the worker, current manager and HR',async()=>{
    const id=await cycle();
    expect((await api(managerToken).get(`/hr/reports/${workerPerson}/competence`)).body.development[0].id).toBe(id);
    expect((await api(hrToken).get(`/hr/people/${workerPerson}/competence`)).status).toBe(200);
    expect((await api(outsiderToken).get(`/hr/reports/${workerPerson}/competence`)).status).toBe(404);
    expect((await api(outsiderToken).post(`/hr/people/${workerPerson}/development`,{
      title:'Unauthorized cycle',periodStart:today,periodEnd:today})).status).toBe(403);
  });

  it('keeps worker narrative separate from manager and HR review events',async()=>{
    const cycleId=await cycle();
    expect((await api(workerToken).post(`/hr/development/${cycleId}/events`,{kind:'reflection',state:null,
      narrative:'I need to strengthen advocacy preparation.',evidenceReference:null})).status).toBe(201);
    expect((await api(managerToken).post(`/hr/development/${cycleId}/events`,{kind:'reflection',state:null,
      narrative:'A manager cannot replace worker reflection.',evidenceReference:null})).status).toBe(404);
    expect((await api(workerToken).post(`/hr/development/${cycleId}/events`,{kind:'review',state:null,
      narrative:'A worker cannot write the manager review.',evidenceReference:null})).status).toBe(404);
    expect((await api(managerToken).post(`/hr/development/${cycleId}/events`,{kind:'requirement',state:null,
      narrative:'Complete one supervised advocacy exercise.',evidenceReference:null})).status).toBe(201);
    expect((await api(hrToken).post(`/hr/development/${cycleId}/events`,{kind:'status',state:'active',
      narrative:'Cycle is active.',evidenceReference:null})).status).toBe(201);
    const record=(await api(workerToken).get('/hr/me/competence')).body.development[0];
    expect(record.events.map((event:{kind:string})=>event.kind)).toEqual(['reflection','requirement','status']);
  });

  it('lets HR assign learning and the worker complete it without manager substitution',async()=>{
    const assigned=await api(hrToken).post(`/hr/people/${workerPerson}/learning-assignments`,{title:'Advanced advocacy',
      provider:'Internal learning',dueOn:tomorrow,details:'Complete the assessed workshop.'});
    expect(assigned.status,JSON.stringify(assigned.body)).toBe(201);
    expect((await api(managerToken).post(`/hr/learning-assignments/${assigned.body.id}/events`,{action:'completed',
      completedOn:today,note:'Manager completion.',evidenceReference:null})).status).toBe(404);
    expect((await api(workerToken).post(`/hr/learning-assignments/${assigned.body.id}/events`,{action:'completed',
      completedOn:tomorrow,note:'Impossible future completion.',evidenceReference:null})).status).toBe(409);
    expect((await api(workerToken).post(`/hr/learning-assignments/${assigned.body.id}/events`,{action:'completed',
      completedOn:today,note:'Workshop completed.',evidenceReference:'Internal certificate 41'})).status).toBe(201);
    expect((await api(workerToken).post(`/hr/learning-assignments/${assigned.body.id}/events`,{action:'completed',
      completedOn:today,note:'Duplicate.',evidenceReference:null})).status).toBe(409);
    expect((await api(workerToken).get('/hr/me/competence')).body.learning[0].events[0])
      .toMatchObject({action:'completed',completedOn:today,evidenceReference:'Internal certificate 41'});
  });

  it('fixes manager objectives and appraisals while preserving worker acknowledgement and disagreement',async()=>{
    expect((await api(workerToken).post(`/hr/reports/${workerPerson}/reviews`,{kind:'objective',title:'Self objective',
      targetOn:tomorrow,statement:'Cannot set own formal objective.'})).status).toBe(404);
    const objective=await api(managerToken).post(`/hr/reports/${workerPerson}/reviews`,{kind:'objective',
      title:'Client communication',targetOn:'2099-12-31',statement:'Lead two supervised client updates.'});
    expect(objective.status,JSON.stringify(objective.body)).toBe(201);
    expect((await api(managerToken).post(`/hr/reviews/${objective.body.id}/worker-events`,{
      action:'acknowledged',note:null})).status).toBe(404);
    expect((await api(workerToken).post(`/hr/reviews/${objective.body.id}/worker-events`,{
      action:'acknowledged',note:null})).status).toBe(201);
    expect((await api(workerToken).post(`/hr/reviews/${objective.body.id}/worker-events`,{
      action:'acknowledged',note:null})).status).toBe(409);
    expect((await api(workerToken).post(`/hr/reviews/${objective.body.id}/worker-events`,{
      action:'disagreement',note:'I disagree with the proposed timing.'})).status).toBe(201);
    const appraisal=await api(hrToken).post(`/hr/people/${workerPerson}/reviews`,{kind:'appraisal',title:'Annual appraisal',
      periodStart:today,periodEnd:today,statement:'The signed annual appraisal statement.'});
    expect(appraisal.status,JSON.stringify(appraisal.body)).toBe(201);
    const reviews=(await api(workerToken).get('/hr/me/competence')).body.reviews;
    expect(reviews.find((item:{id:string})=>item.id===objective.body.id).workerEvents).toHaveLength(2);
    expect(reviews.find((item:{id:string})=>item.id===appraisal.body.id).statement).toContain('annual appraisal');
  });

  it('encrypts narrative and keeps it out of ordinary audit metadata',async()=>{
    const cycleId=await cycle(),secret=`Private reflection ${randomUUID()}`;
    const event=await api(workerToken).post(`/hr/development/${cycleId}/events`,{kind:'reflection',state:null,
      narrative:secret,evidenceReference:'Private evidence reference'});
    const raw=await ownerDb.selectFrom('hr_development_events').select(['context','ciphertext']).where('id','=',event.body.id)
      .executeTakeFirstOrThrow();expect(raw.context).toBe(`hr-development-event:${event.body.id}`);
    expect(raw.ciphertext.toString('utf8')).not.toContain(secret);
    expect(JSON.stringify(await ownerDb.selectFrom('audit_events').select('metadata').where('resource_id','=',cycleId).execute()))
      .not.toContain('Private');
  });

  it('uses the Compliance-owned safe AML training projection without evidence leakage',async()=>{
    const compliance=await staffWith('compliance'),partner=await staffWith('partner');
    const content=`Training material ${randomUUID()}`,material=(await sql<{id:string}>`select app.create_aml_control_version(
      'training_material','Annual AML course',${content},${createHash('sha256').update(content).digest()},
      'Firm AML programme',${today}::date,'2099-12-31'::date,${compliance.id}) id`.execute(db)).rows[0]!.id;
    await sql`select app.approve_aml_control_version(${material},${partner.id})`.execute(db);
    await sql`select app.record_aml_training(${worker.id},${material},'Secret provider',${today}::date,
      'Secret certificate reference',${compliance.id})`.execute(db);
    const response=await api(hrToken).get(`/hr/people/${workerPerson}/competence`);
    expect(response.body.amlTraining).toContainEqual(expect.objectContaining({materialId:material,title:'Annual AML course',
      completedOn:today,status:'completed'}));
    expect(JSON.stringify(response.body)).not.toContain('Secret provider');
    expect(JSON.stringify(response.body)).not.toContain('Secret certificate');
  });

  it('rejects malformed review shapes and unknown fields',async()=>{
    expect((await api(managerToken).post(`/hr/reports/${workerPerson}/reviews`,{kind:'appraisal',title:'Bad appraisal',
      targetOn:tomorrow,statement:'Wrong date shape.',score:99})).status).toBe(400);
    const cycleId=await cycle();
    expect((await api(workerToken).post(`/hr/development/${cycleId}/events`,{kind:'status',state:null,
      narrative:'Missing state.',evidenceReference:null})).status).toBe(400);
  });

  it('denies direct application access and owner mutation of competence history',async()=>{
    await expect(db.selectFrom('hr_review_records').selectAll().execute()).rejects.toThrow(/permission denied/);
    const cycleId=await cycle();
    await expect(ownerDb.updateTable('hr_development_cycles').set({title:'Rewritten'} as never).where('id','=',cycleId).execute())
      .rejects.toThrow(/immutable/);
    await expect(sql`truncate app.hr_review_records cascade`.execute(ownerDb)).rejects.toThrow(/cannot be truncated/);
  });
});
