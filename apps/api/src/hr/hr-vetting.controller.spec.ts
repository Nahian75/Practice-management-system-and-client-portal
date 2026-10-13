import { randomUUID } from 'node:crypto';
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

@Module({ imports:[HrModule] }) class HrVettingTestModule {}
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const pattern={ timeZone:'Europe/London',mondayMinutes:450,tuesdayMinutes:450,wednesdayMinutes:450,
  thursdayMinutes:450,fridayMinutes:420,saturdayMinutes:0,sundayMinutes:0 };

describe('People / HR lifecycle and vetting API',()=>{
  let app:NestExpressApplication,db:Kysely<Database>,ownerDb:Kysely<Database>,sessions:SessionsService;
  let hr:TestAccount,worker:TestAccount,manager:TestAccount,admin:TestAccount;
  let hrToken:string,workerToken:string,managerToken:string,adminToken:string;
  let workerPerson:string,managerPerson:string,engagementId:string,today:string,yesterday:string,tomorrow:string;

  const api=(token:string)=>{ const server=request(app.getHttpServer()),cookie=`__Host-session=${token}`; return {
    get:(path:string)=>server.get(path).set('Cookie',cookie),
    post:(path:string,body:object)=>server.post(path).set('Cookie',cookie).send(body),
    upload:(path:string)=>server.post(path).set('Cookie',cookie),
  }; };
  async function staffWith(...roles:StaffRole[]) { const account=await createTestAccount(db,'staff');
    for (const role of roles) await grantTestRole(db,account.id,role); return account; }
  async function createPerson(account:TestAccount) { const response=await api(hrToken).post('/hr/people',{ accountId:account.id });
    expect(response.status,JSON.stringify(response.body)).toBe(201); return response.body.personId as string; }
  async function engage(personId:string,title='Solicitor') { const response=await api(hrToken).post(`/hr/people/${personId}/engagements`,{
    kind:'employee',startedOn:yesterday,jobTitle:title,team:'Disputes',workLocation:'London',pattern });
    expect(response.status,JSON.stringify(response.body)).toBe(201); return response.body.engagementId as string; }
  async function identityFile(personId=workerPerson) { const upload=await api(hrToken).upload(`/hr/people/${personId}/files`)
    .field('category','identity').field('workerVisible','true').attach('file',PDF,'right-to-work.pdf');
    expect(upload.status,JSON.stringify(upload.body)).toBe(201); return upload.body.files[0].id as string; }
  async function createJoiner() { const response=await api(hrToken).post(`/hr/people/${workerPerson}/lifecycle`,{
    engagementId,kind:'joiner',effectiveOn:yesterday,items:[{ code:'rtw_checked',title:'Right to work checked',
      ownerKind:'hr',required:true,dueOn:today }] });
    expect(response.status,JSON.stringify(response.body)).toBe(201); return response.body.id as string; }
  async function passRightToWork(fileId:string,overrides:Record<string,unknown>={}) { return api(hrToken)
    .post(`/hr/people/${workerPerson}/right-to-work`,{ engagementId,guidanceVersion:'Home Office checklist 2026-09',
      checkRoute:'online',checkedOn:today,permissionType:'british_or_irish',result:'passed',expiresOn:null,
      followUpOn:null,evidenceFileId:fileId,identityMatchMethod:'Online identity matched in person.',
      workRestrictions:null,providerReference:'RTW-PRIVATE-001',...overrides }); }

  beforeAll(async()=>{ app=await createTestApp(HrVettingTestModule); db=app.get(DATABASE);
    ownerDb=createDatabase<Database>(testOwnerDatabaseUrl(),1); sessions=app.get(SessionsService);
    const row=(await sql<{ today:string;yesterday:string;tomorrow:string }>`select current_date::text today,
      (current_date-1)::text yesterday,(current_date+1)::text tomorrow`.execute(db)).rows[0]!;
    ({ today,yesterday,tomorrow }=row);
  });
  afterAll(async()=>{ await ownerDb.destroy(); await app.close(); });
  beforeEach(async()=>{ hr=await staffWith('hr'); worker=await staffWith('fee_earner'); manager=await staffWith('partner');
    admin=await staffWith('administrator'); [hrToken,workerToken,managerToken,adminToken]=await Promise.all([
      sessions.start(hr,'authenticated',{}),sessions.start(worker,'authenticated',{}),
      sessions.start(manager,'authenticated',{}),sessions.start(admin,'authenticated',{}) ]);
    workerPerson=await createPerson(worker); managerPerson=await createPerson(manager);
    engagementId=await engage(workerPerson); await engage(managerPerson,'Partner');
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/manager`,{
      managerPersonId:managerPerson,effectiveOn:yesterday })).status).toBe(201);
  });

  it('keeps lifecycle administration HR-only while exposing safe self and current-manager views',async()=>{
    expect((await api(adminToken).post(`/hr/people/${workerPerson}/lifecycle`,{
      engagementId,kind:'joiner',effectiveOn:yesterday,items:[{ code:'account',title:'Account ready',ownerKind:'administrator',required:true }]
    })).status).toBe(403);
    const checklistId=await createJoiner();
    const self=await api(workerToken).get('/hr/me/lifecycle');
    expect(self.status).toBe(200); expect(self.body.checklists[0]).toMatchObject({ id:checklistId,kind:'joiner',state:'open' });
    expect((await api(managerToken).get(`/hr/reports/${workerPerson}/lifecycle`)).body.checklists[0].items[0]
      .title).toBe('Right to work checked');
    expect((await api(adminToken).get(`/hr/reports/${workerPerson}/lifecycle`)).status).toBe(404);
  });

  it('requires completed items and current passing right-to-work evidence before joiner completion',async()=>{
    const checklistId=await createJoiner();
    const lifecycle=(await api(hrToken).get(`/hr/people/${workerPerson}/lifecycle`)).body;
    const itemId=lifecycle.checklists[0].items[0].id;
    expect((await api(hrToken).post(`/hr/lifecycle/items/${itemId}/events`,{
      action:'completed',note:'Required check finished.' })).status).toBe(201);
    expect((await api(hrToken).post(`/hr/lifecycle/${checklistId}/events`,{
      action:'completed',note:'Tried before vetting evidence.' })).status).toBe(409);
    const rtw=await passRightToWork(await identityFile());
    expect(rtw.status,JSON.stringify(rtw.body)).toBe(201); expect(rtw.body.version).toBe(1);
    expect((await api(hrToken).post(`/hr/lifecycle/${checklistId}/events`,{
      action:'completed',note:'All required evidence is now current.' })).status).toBe(201);
    expect((await api(hrToken).post(`/hr/lifecycle/items/${itemId}/events`,{
      action:'reopened',note:'Cannot alter a completed checklist.' })).status).toBe(409);
  });

  it('binds right-to-work evidence to the person and keeps sensitive details encrypted',async()=>{
    const other=await staffWith('fee_earner'),otherPerson=await createPerson(other),otherFile=await identityFile(otherPerson);
    expect((await passRightToWork(otherFile)).status).toBe(404);
    const fileId=await identityFile();
    const created=await passRightToWork(fileId);
    expect(created.status).toBe(201);
    const raw=await ownerDb.selectFrom('hr_right_to_work_checks').select(['context','ciphertext'])
      .where('id','=',created.body.id).executeTakeFirstOrThrow();
    expect(raw.context).toBe(`hr-rtw:${created.body.id}`);
    expect(raw.ciphertext.toString('utf8')).not.toContain('RTW-PRIVATE-001');
    expect(JSON.stringify(await ownerDb.selectFrom('audit_events').select('metadata')
      .where('resource_id','=',created.body.id).execute())).not.toContain('passed');
  });

  it('versions expiry/follow-ups, rejects invalid dates and exposes a generic due queue',async()=>{
    const fileId=await identityFile();
    expect((await passRightToWork(fileId,{ permissionType:'time_limited',expiresOn:tomorrow })).status).toBe(201);
    const due=await api(hrToken).get('/hr/vetting/due');
    expect(due.body.checks).toContainEqual(expect.objectContaining({ personId:workerPerson,expiresOn:tomorrow }));
    const second=await passRightToWork(fileId,{ permissionType:'time_limited',
      expiresOn:'2099-01-01',followUpOn:'2098-12-01' });
    expect(second.status).toBe(201); expect(second.body.version).toBe(2);
    expect((await passRightToWork(fileId,{ checkedOn:yesterday })).status).toBe(409);
    expect((await passRightToWork(fileId,{ checkedOn:tomorrow })).status).toBe(409);
  });

  it('blocks joiner or mover completion after a failed latest follow-up',async()=>{
    const fileId=await identityFile(); await passRightToWork(fileId);
    expect((await passRightToWork(fileId,{ result:'failed' })).status).toBe(201);
    const moved=await api(hrToken).post(`/hr/people/${workerPerson}/lifecycle`,{
      engagementId,kind:'mover',effectiveOn:today,items:[{ code:'terms',title:'New terms issued',ownerKind:'hr',required:true }]
    });
    const itemId=(await api(hrToken).get(`/hr/people/${workerPerson}/lifecycle`)).body.checklists
      .find((item:{ id:string })=>item.id===moved.body.id).items[0].id;
    await api(hrToken).post(`/hr/lifecycle/items/${itemId}/events`,{ action:'completed',note:'Terms issued.' });
    expect((await api(hrToken).post(`/hr/lifecycle/${moved.body.id}/events`,{
      action:'completed',note:'Failed check must block this.' })).status).toBe(409);
  });

  it('gives managers only expiry/action vetting data while workers and HR get their proper views',async()=>{
    await passRightToWork(await identityFile());
    const self=await api(workerToken).get('/hr/me/vetting');
    expect(self.status,JSON.stringify(self.body)).toBe(200);
    expect(self.body.rightToWork[0]).toMatchObject({ result:'passed',permissionType:'british_or_irish' });
    expect(self.body.rightToWorkChecks).toEqual([]);
    const managerView=await api(managerToken).get(`/hr/reports/${workerPerson}/vetting`);
    expect(managerView.body.rightToWork[0]).toMatchObject({ result:null,permissionType:null,checkedOn:null,actionRequired:false });
    expect(JSON.stringify(managerView.body)).not.toContain('RTW-PRIVATE-001');
    const hrView=await api(hrToken).get(`/hr/people/${workerPerson}/vetting`);
    expect(hrView.body.rightToWorkChecks[0].details.providerReference).toBe('RTW-PRIVATE-001');
  });

  it('records encrypted qualifications and projects only operational status to the manager',async()=>{
    const identifier=`SRA-${randomUUID()}`,restriction='Private practising restriction.';
    const created=await api(hrToken).post(`/hr/people/${workerPerson}/professional-records`,{
      kind:'practising_certificate',title:'Solicitor practising certificate',issuer:'Solicitors Regulation Authority',
      validFrom:today,validTo:'2099-12-31',identifier,restriction });
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    expect((await api(hrToken).post(`/hr/professional-records/${created.body.id}/checks`,{
      status:'current',checkedOn:tomorrow,source:'Future source',note:null })).status).toBe(409);
    expect((await api(hrToken).post(`/hr/professional-records/${created.body.id}/checks`,{
      status:'restricted',checkedOn:today,source:'SRA register checked online',note:'Private source note.' })).status).toBe(201);
    const self=await api(workerToken).get('/hr/me/vetting');
    expect(self.body.professional[0]).toMatchObject({ identifier,restriction,status:'restricted',
      source:'SRA register checked online' });
    const managerView=await api(managerToken).get(`/hr/reports/${workerPerson}/vetting`);
    expect(managerView.body.professional[0]).toMatchObject({ identifier:null,restriction:null,status:'restricted',source:null });
    expect(JSON.stringify(managerView.body)).not.toContain('Private');
    const raw=await ownerDb.selectFrom('hr_professional_records').select('ciphertext').where('id','=',created.body.id)
      .executeTakeFirstOrThrow(); expect(raw.ciphertext.toString('utf8')).not.toContain(identifier);
    expect((await api(hrToken).post(`/hr/professional-records/${created.body.id}/checks`,{
      status:'current',checkedOn:yesterday,source:'Backdated source',note:null })).status).toBe(409);
  });

  it('records a structured leaver reason and reports blockers without changing owning modules',async()=>{
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/end-engagement`,{
      engagementId,endedOn:today,reason:'Worker resigned.' })).status).toBe(201);
    const created=await api(hrToken).post(`/hr/people/${workerPerson}/lifecycle`,{
      engagementId,kind:'leaver',effectiveOn:today,reasonCategory:'resignation',items:[{
        code:'handover',title:'Handover confirmed',ownerKind:'other_module',required:true,dueOn:today }]
    });
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const blockers=await api(hrToken).get(`/hr/lifecycle/${created.body.id}/blockers`);
    expect(blockers.status,JSON.stringify(blockers.body)).toBe(200);
    expect(blockers.body.blockers).toContainEqual(expect.objectContaining({ kind:'account',resourceId:worker.id,status:'active' }));

    const createdCase = await api(hrToken).post('/hr/cases', {
      personId: managerPerson, kind: 'grievance', policyVersion: '2026-v1', issue: 'Staff grievance investigation.',
    });
    expect(createdCase.status, JSON.stringify(createdCase.body)).toBe(201);
    const addedMember = await api(hrToken).post(`/hr/cases/${createdCase.body.id}/members`, {
      accountId: worker.id, role: 'investigator',
    });
    expect(addedMember.status, JSON.stringify(addedMember.body)).toBe(201);

    const updatedBlockers = await api(hrToken).get(`/hr/lifecycle/${created.body.id}/blockers`);
    expect(updatedBlockers.body.blockers).toContainEqual(expect.objectContaining({
      kind: 'case_membership', resourceId: createdCase.body.id, status: 'grievance',
    }));

    const itemId=(await api(hrToken).get(`/hr/people/${workerPerson}/lifecycle`)).body.checklists[0].items[0].id;
    await api(hrToken).post(`/hr/lifecycle/items/${itemId}/events`,{ action:'completed',note:'Handover checked.' });
    expect((await api(hrToken).post(`/hr/lifecycle/${created.body.id}/events`,{
      action:'completed',note:'HR cannot bypass the active account blocker.' })).status).toBe(409);
    expect((await ownerDb.selectFrom('accounts').select('status').where('id','=',worker.id).executeTakeFirstOrThrow()).status).toBe('active');
  });

  it('rejects invalid lifecycle shapes and unknown fields',async()=>{
    expect((await api(hrToken).post(`/hr/people/${workerPerson}/lifecycle`,{
      engagementId,kind:'joiner',effectiveOn:yesterday,reasonCategory:'resignation',items:[{
        code:'bad',title:'Bad shape',ownerKind:'hr',required:true,role:'administrator' }]
    })).status).toBe(400);
  });

  it('denies direct application access and owner mutation of lifecycle and vetting history',async()=>{
    await expect(db.selectFrom('hr_right_to_work_checks').selectAll().execute()).rejects.toThrow(/permission denied/);
    const checklistId=await createJoiner();
    await expect(sql`update app.hr_lifecycle_checklists set effective_on=${today}::date
      where id=${checklistId}::uuid`.execute(ownerDb)).rejects.toThrow(/immutable/);
    await expect(sql`truncate app.hr_professional_records cascade`.execute(ownerDb)).rejects.toThrow(/cannot be truncated/);
  });
});
