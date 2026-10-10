import { createHash, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { createTestApp } from '../../test/create-test-app.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, StaffRole } from '../database/schema.js';
import { ComplianceModule } from './compliance.module.js';

@Module({ imports: [ComplianceModule] })
class CddTestModule {}

describe('Client CDD API', () => {
  let app:NestExpressApplication;let db:Kysely<Database>;let sessions:SessionsService;
  let partner:TestAccount;let feeEarner:TestAccount;let compliance:TestAccount;let accounts:TestAccount;
  let partnerToken:string;let feeToken:string;let complianceToken:string;let accountsToken:string;let today:string;
  const cookie=(token:string)=>`__Host-session=${token}`;
  const api=(token:string)=>{const server=request(app.getHttpServer());return {get:(path:string)=>server.get(path).set('Cookie',cookie(token)),post:(path:string,body:object)=>server.post(path).set('Cookie',cookie(token)).send(body),upload:(path:string)=>server.post(path).set('Cookie',cookie(token))};};
  async function staffWith(...roles:StaffRole[]){const account=await createTestAccount(db,'staff');for(const role of roles)await grantTestRole(db,account.id,role);return account;}
  async function client(owner=partner){return db.transaction().execute(async(trx)=>{const c=await trx.insertInto('clients').values({kind:'individual',created_by:owner.id}).returning('id').executeTakeFirstOrThrow();await trx.insertInto('client_individuals').values({client_id:c.id,title:null,given_names:'Ada',family_name:`Lovelace ${randomUUID()}`,date_of_birth:'1980-01-02',email:null,phone:null,address_line1:'1 Test Street',address_line2:null,town:'London',postcode:'SW1A 1AA',country:'GB'}).execute();return c.id;});}
  async function organisation(){return db.transaction().execute(async(trx)=>{const c=await trx.insertInto('clients').values({kind:'organisation',created_by:partner.id}).returning('id').executeTakeFirstOrThrow();await trx.insertInto('client_organisations').values({client_id:c.id,legal_name:`Analytical Engines ${randomUUID()}`,organisation_type:'company',registration_number:'12345678',email:null,phone:null,address_line1:'1 Test Street',address_line2:null,town:'London',postcode:'SW1A 1AA',country:'GB'}).execute();return c.id;});}
  const draft=(token:string,clientId:string)=>api(token).post(`/clients/${clientId}/cdd`,{intendedRelationship:'Ongoing legal advice for the client',reason:'Identity and ownership checks before accepting instructions'});
  async function evidence(token:string,clientId:string,caseId:string,name='passport.pdf'){
    return api(token).upload(`/clients/${clientId}/cdd/${caseId}/evidence`).field('evidenceType','passport').field('country','GB').field('issuedOn','2020-01-01').field('expiresOn','2030-01-01').field('documentIdentifier','123456789').attach('file',Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'),name);
  }

  beforeAll(async()=>{
    app=await createTestApp(CddTestModule);db=app.get(DATABASE);sessions=app.get(SessionsService);
    today=(await sql<{today:string}>`select (clock_timestamp() at time zone 'Europe/London')::date::text as today`.execute(db)).rows[0]!.today;
    const preparer=await staffWith('compliance');const approver=await staffWith('partner');
    for(const kind of ['ml_tf_risk_assessment','proliferation_financing_risk_assessment','sanctions_risk_assessment','aml_policy','sanctions_policy']){
      const content=`Current ${kind} ${randomUUID()}`;const id=(await sql<{id:string}>`select app.create_aml_control_version(${kind},${`Current ${kind}`},${content},${createHash('sha256').update(content).digest()},'CDD test control source',${today}::date,'2099-12-31'::date,${preparer.id}) as id`.execute(db)).rows[0]!.id;
      await sql`select app.approve_aml_control_version(${id},${approver.id})`.execute(db);
    }
  });
  afterAll(async()=>app.close());
  beforeEach(async()=>{
    partner=await staffWith('partner');feeEarner=await staffWith('fee_earner');compliance=await staffWith('compliance');accounts=await staffWith('accounts');
    [partnerToken,feeToken,complianceToken,accountsToken]=await Promise.all([
      sessions.start(partner,'authenticated',{}),sessions.start(feeEarner,'authenticated',{}),
      sessions.start(compliance,'authenticated',{}),sessions.start(accounts,'authenticated',{}),
    ]);
  });

  it('limits preparation to visible clients while Compliance has firm-wide access',async()=>{
    const clientId=await client();expect((await draft(accountsToken,clientId)).status).toBe(403);expect((await draft(feeToken,clientId)).status).toBe(404);
    const created=await draft(complianceToken,clientId);expect(created.status,JSON.stringify(created.body)).toBe(201);expect(created.body).toMatchObject({clientId,version:1,status:'draft'});
    expect((await api(feeToken).get(`/clients/${clientId}/cdd`)).status).toBe(404);const listed=await api(complianceToken).get(`/clients/${clientId}/cdd`);expect(listed.status).toBe(200);expect(listed.body.cases[0]).not.toHaveProperty('reason');expect(JSON.stringify(listed.body)).not.toContain('Identity and ownership');
  });

  it('answers 404 for an unknown client on every read and upload path',async()=>{
    const clientId=randomUUID();const caseId=randomUUID();
    expect((await api(complianceToken).get(`/clients/${clientId}/cdd`)).status).toBe(404);
    expect((await api(complianceToken).get(`/clients/${clientId}/cdd/${caseId}`)).status).toBe(404);
    expect((await api(complianceToken).get(`/clients/${clientId}/cdd/${caseId}/evidence/${randomUUID()}/content`)).status).toBe(404);
    expect((await evidence(complianceToken,clientId,caseId)).status).toBe(404);
  });

  it('records protected evidence and submits a complete immutable case',async()=>{
    const clientId=await client();const created=await draft(partnerToken,clientId);expect(created.status).toBe(201);const caseId=created.body.id;
    const uploaded=await evidence(partnerToken,clientId,caseId);expect(uploaded.status,JSON.stringify(uploaded.body)).toBe(201);const evidenceId=uploaded.body.evidence[0].id;
    const subject=await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'individual',relationship:'client',details:{name:'Ada Lovelace',dateOfBirth:'1980-01-02',nationality:'British',countryOfResidence:'GB'}});
    expect(subject.status,JSON.stringify(subject.body)).toBe(201);const subjectId=subject.body.subjects[0].id;
    const verification=await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/verifications`,{subjectId,evidenceId,sourceType:'Government passport',country:'GB',checkedOn:today,expiresOn:'2030-01-01',method:'in_person',outcome:'verified',documentIdentifier:'123456789'});
    expect(verification.status,JSON.stringify(verification.body)).toBe(201);
    const submitted=await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/submit`,{});expect(submitted.status,JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({status:'submitted',clientSnapshot:{reference:expect.any(String),name:expect.stringContaining('Ada')},controls:expect.arrayContaining([expect.objectContaining({kind:'aml_policy'})])});
    expect(submitted.body.controls).toHaveLength(5);expect((await evidence(partnerToken,clientId,caseId,'late.pdf')).status).toBe(409);
    const raw=await db.selectFrom('aml_cdd_evidence').selectAll().where('id','=',evidenceId).executeTakeFirstOrThrow();expect(raw.storage_key).toMatch(/^compliance\//);expect(raw.metadata_ciphertext.toString('utf8')).not.toContain('123456789');
    const audit=await db.selectFrom('audit_events').select(['action','metadata']).where('resource_id','=',caseId).execute();expect(audit.map((x)=>x.action)).toContain('aml.cdd_submitted');expect(JSON.stringify(audit)).not.toContain('123456789');
  });

  it('requires verification for every subject and authority for representatives',async()=>{
    const clientId=await client();const created=await draft(partnerToken,clientId);const caseId=created.body.id;
    await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'individual',relationship:'client',details:{name:'Unverified Client',dateOfBirth:'1980-01-02'}});
    expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/submit`,{})).status).toBe(409);
  });

  it('allows only one live draft and gives submitted cases stable versions',async()=>{
    const clientId=await client();const first=await draft(partnerToken,clientId);expect(first.status).toBe(201);expect((await draft(partnerToken,clientId)).status).toBe(409);
    const abandoned=await api(partnerToken).post(`/clients/${clientId}/cdd/${first.body.id}/abandon`,{reason:'The draft contains incorrect source material and will be replaced'});expect(abandoned.status).toBe(201);expect(abandoned.body).toMatchObject({status:'abandoned',abandonment:{by:{accountId:partner.id},reason:expect.any(String)}});
    const replacement=await draft(partnerToken,clientId);expect(replacement.status).toBe(201);expect(replacement.body.version).toBe(2);expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${first.body.id}/submit`,{})).status).toBe(409);
  });

  it('refuses cross-case evidence and subject references',async()=>{
    const firstClient=await client();const secondClient=await client();const first=(await draft(partnerToken,firstClient)).body;const second=(await draft(partnerToken,secondClient)).body;
    const uploaded=await evidence(partnerToken,firstClient,first.id);const evidenceId=uploaded.body.evidence[0].id;
    const subject=await api(partnerToken).post(`/clients/${secondClient}/cdd/${second.id}/subjects`,{kind:'individual',relationship:'client',details:{name:'Second Client',dateOfBirth:'1980-01-02'}});const subjectId=subject.body.subjects[0].id;
    const result=await api(partnerToken).post(`/clients/${secondClient}/cdd/${second.id}/verifications`,{subjectId,evidenceId,sourceType:'Passport',country:'GB',checkedOn:today,method:'manual',outcome:'verified'});expect(result.status).toBe(409);
  });

  it('streams evidence only to authorised viewers and audits the view without identity data',async()=>{
    const clientId=await client();const caseId=(await draft(partnerToken,clientId)).body.id;const uploaded=await evidence(partnerToken,clientId,caseId);const evidenceId=uploaded.body.evidence[0].id;
    expect((await api(feeToken).get(`/clients/${clientId}/cdd/${caseId}/evidence/${evidenceId}/content`)).status).toBe(404);
    const downloaded=await api(partnerToken).get(`/clients/${clientId}/cdd/${caseId}/evidence/${evidenceId}/content`);expect(downloaded.status).toBe(200);expect(downloaded.headers['content-disposition']).toContain('passport.pdf');
    const event=await db.selectFrom('audit_events').selectAll().where('action','=','aml.evidence_viewed').where('resource_id','=',evidenceId).executeTakeFirstOrThrow();expect(event.metadata).toEqual({caseId});
  });

  it('rejects unknown fields and unsafe direction-control text',async()=>{
    const clientId=await client();expect((await api(partnerToken).post(`/clients/${clientId}/cdd`,{intendedRelationship:'Ordinary instructions',reason:'A sufficient onboarding reason',unexpected:true})).status).toBe(400);
    expect((await api(partnerToken).post(`/clients/${clientId}/cdd`,{intendedRelationship:'Ordinary instructions',reason:'Hidden direction\u202E control'})).status).toBe(400);
  });

  it('records a traversable organisation, ownership and representative-authority graph',async()=>{
    const clientId=await organisation();const caseId=(await draft(partnerToken,clientId)).body.id;const evidenceId=(await evidence(partnerToken,clientId,caseId,'registry.pdf')).body.evidence[0].id;
    const entity=(await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'legal_entity',relationship:'client',details:{name:'Analytical Engines Ltd',legalForm:'Private company limited by shares',governingLaw:'England and Wales',registrationNumber:'12345678',registeredOffice:'1 Test Street, London',principalOffice:'1 Test Street, London'}})).body.subjects[0].id;
    const owner=(await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'individual',relationship:'beneficial_owner',details:{name:'Grace Hopper',dateOfBirth:'1980-01-02',countryOfResidence:'GB'}})).body.subjects.find((x:{relationship:string})=>x.relationship==='beneficial_owner').id;
    const representative=(await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'individual',relationship:'authorised_representative',details:{name:'Katherine Johnson',dateOfBirth:'1980-01-02',countryOfResidence:'GB'}})).body.subjects.find((x:{relationship:string})=>x.relationship==='authorised_representative').id;
    expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/ownership`,{ownedSubjectId:entity,controllerSubjectId:owner,ownershipPercent:'60.00',controlKind:'ownership',details:'Direct ownership recorded in the current register of members'})).status).toBe(201);
    expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/authorities`,{representativeSubjectId:representative,representedSubjectId:entity,evidenceId,authorityType:'Board authority',verifiedOn:today,details:'Board resolution authorises the representative to instruct the firm'})).status).toBe(201);
    for(const subjectId of [entity,owner,representative])expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/verifications`,{subjectId,evidenceId,sourceType:'Reliable independent source',country:'GB',checkedOn:today,method:'manual',outcome:'verified'})).status).toBe(201);
    const submitted=await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/submit`,{});expect(submitted.status,JSON.stringify(submitted.body)).toBe(201);expect(submitted.body).toMatchObject({status:'submitted',ownership:[{ownedSubjectId:entity,controllerSubjectId:owner}],authorities:[{representativeSubjectId:representative,representedSubjectId:entity}]});
  });

  it('requires provider and service for electronic verification',async()=>{
    const clientId=await client();const caseId=(await draft(partnerToken,clientId)).body.id;const evidenceId=(await evidence(partnerToken,clientId,caseId)).body.evidence[0].id;const subjectId=(await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/subjects`,{kind:'individual',relationship:'client',details:{name:'Ada Lovelace',dateOfBirth:'1980-01-02'}})).body.subjects[0].id;
    expect((await api(partnerToken).post(`/clients/${clientId}/cdd/${caseId}/verifications`,{subjectId,evidenceId,sourceType:'Digital identity',country:'GB',checkedOn:today,method:'electronic',outcome:'verified'})).status).toBe(400);
  });
});
