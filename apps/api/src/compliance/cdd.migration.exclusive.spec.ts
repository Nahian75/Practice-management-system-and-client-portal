import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

describe('CDD database rules',()=>{
  let db:Kysely<Database>;let owner:Kysely<Database>;let partner:TestAccount;let compliance:TestAccount;let today:string;
  async function staffWith(...roles:StaffRole[]){const a=await createTestAccount(db,'staff');for(const role of roles)await grantTestRole(db,a.id,role);return a;}
  async function client(createdBy=partner.id){return db.transaction().execute(async(trx)=>{const c=await trx.insertInto('clients').values({kind:'organisation',created_by:createdBy}).returning('id').executeTakeFirstOrThrow();await trx.insertInto('client_organisations').values({client_id:c.id,legal_name:`Test Company ${randomUUID()}`,organisation_type:'company',registration_number:'12345678',email:null,phone:null,address_line1:'1 Test Street',address_line2:null,town:'London',postcode:'SW1A 1AA',country:'GB'}).execute();return c.id;});}
  async function createCase(clientId:string,actorId=partner.id){return (await sql<{id:string}>`select app.create_aml_cdd_case(${clientId},'Ongoing corporate legal services','CDD before accepting the proposed instructions',${actorId}) as id`.execute(db)).rows[0]!.id;}
  const crypt=(context:string)=>({context,key:1,nonce:Buffer.alloc(12,1),ciphertext:Buffer.from('{}'),tag:Buffer.alloc(16,2)});
  async function evidence(caseId:string,actorId=partner.id){const id=randomUUID();const x=crypt(`aml-evidence-metadata:${id}`);await sql`select app.add_aml_cdd_evidence(${id},${caseId},'passport','GB'::char(2),'2020-01-01'::date,'2099-01-01'::date,${x.context},${x.key}::smallint,${x.nonce},${x.ciphertext},${x.tag},'application/pdf',10,${Buffer.alloc(32,3)},${`compliance/${randomUUID()}`},1::smallint,${Buffer.alloc(12,4)},${Buffer.alloc(32,5)},${Buffer.alloc(16,6)},${actorId})`.execute(db);return id;}
  async function subject(caseId:string,relationship='client',actorId=partner.id){const id=randomUUID();const x=crypt(`aml-subject:${id}`);await sql`select app.add_aml_cdd_subject(${id},${caseId},'legal_entity',${relationship},${x.context},${x.key}::smallint,${x.nonce},${x.ciphertext},${x.tag},${actorId})`.execute(db);return id;}
  async function verify(caseId:string,subjectId:string,evidenceId:string,actorId=partner.id){const id=randomUUID();const x=crypt(`aml-verification:${id}`);await sql`select app.add_aml_cdd_verification(${id},${caseId},${subjectId},${evidenceId},'Companies registry','GB'::char(2),${today}::date,'2099-01-01'::date,'manual','verified',null,null,${x.context},${x.key}::smallint,${x.nonce},${x.ciphertext},${x.tag},${actorId})`.execute(db);return id;}

  beforeAll(async()=>{db=createDatabase<Database>(testAppDatabaseUrl(),4);owner=createDatabase<Database>(testOwnerDatabaseUrl(),2);today=(await sql<{today:string}>`select (clock_timestamp() at time zone 'Europe/London')::date::text today`.execute(db)).rows[0]!.today;const preparer=await staffWith('compliance');const approver=await staffWith('partner');for(const kind of ['ml_tf_risk_assessment','proliferation_financing_risk_assessment','sanctions_risk_assessment','aml_policy','sanctions_policy']){const content=`Database test ${kind} ${randomUUID()}`;const id=(await sql<{id:string}>`select app.create_aml_control_version(${kind},'Current control',${content},${createHash('sha256').update(content).digest()},'Test source',${today}::date,'2099-12-31'::date,${preparer.id}) id`.execute(db)).rows[0]!.id;await sql`select app.approve_aml_control_version(${id},${approver.id})`.execute(db);}});
  afterAll(async()=>{await owner.destroy();await db.destroy();});
  beforeEach(async()=>{partner=await staffWith('partner');compliance=await staffWith('compliance');});

  it('denies direct application and owner inserts outside protected functions',async()=>{
    const clientId=await client();await expect(sql`insert into app.aml_cdd_cases(client_id,version,intended_relationship,reason,prepared_by) values(${clientId},98,'Direct relationship','Direct unprotected reason',${partner.id})`.execute(db)).rejects.toMatchObject({code:'42501'});
    await expect(sql`insert into app.aml_cdd_cases(client_id,version,intended_relationship,reason,prepared_by) values(${clientId},99,'Direct relationship','Direct unprotected reason',${partner.id})`.execute(owner)).rejects.toMatchObject({code:'42501'});
  });

  it('rechecks live roles and client visibility inside database functions',async()=>{
    const clientId=await client();const outsider=await staffWith('fee_earner');await expect(createCase(clientId,outsider.id)).rejects.toMatchObject({code:'42501'});
    const caseId=await createCase(clientId,compliance.id);expect(caseId).toEqual(expect.any(String));
    await db.updateTable('account_roles').set({revoked_at:new Date(),revoked_by:partner.id}).where('account_id','=',compliance.id).where('role','=','compliance').execute();
    await expect(subject(caseId,'client',compliance.id)).rejects.toMatchObject({code:'42501'});
  });

  it('keeps submitted history immutable even for the owner',async()=>{
    const clientId=await client();const caseId=await createCase(clientId);const evidenceId=await evidence(caseId);const subjectId=await subject(caseId);await verify(caseId,subjectId,evidenceId);await sql`select app.submit_aml_cdd_case(${caseId},${partner.id})`.execute(db);
    await expect(owner.updateTable('aml_cdd_cases').set({reason:'Rewritten reason'} as never).where('id','=',caseId).execute()).rejects.toMatchObject({code:'42501'});
    await expect(owner.updateTable('aml_cdd_subjects').set({relationship:'beneficial_owner'} as never).where('id','=',subjectId).execute()).rejects.toMatchObject({code:'42501'});
    await expect(owner.deleteFrom('aml_cdd_evidence').where('id','=',evidenceId).execute()).rejects.toMatchObject({code:'42501'});
    await expect(sql`truncate app.aml_cdd_verifications cascade`.execute(owner)).rejects.toMatchObject({code:'42501'});
    await expect(subject(caseId)).rejects.toMatchObject({code:'23514'});
  });

  it('rejects cross-case references and incomplete submission',async()=>{
    const first=await createCase(await client());const second=await createCase(await client());const evidenceId=await evidence(first);const subjectId=await subject(second);
    await expect(verify(second,subjectId,evidenceId)).rejects.toMatchObject({code:'23514'});
    await expect(sql`select app.submit_aml_cdd_case(${second},${partner.id})`.execute(db)).rejects.toMatchObject({code:'23514'});
  });

  it('serializes competing drafts so only one can exist',async()=>{
    const clientId=await client();const attempts=await Promise.allSettled([createCase(clientId),createCase(clientId)]);expect(attempts.filter((x)=>x.status==='fulfilled')).toHaveLength(1);const rejected=attempts.find((x):x is PromiseRejectedResult=>x.status==='rejected');expect(rejected?.reason).toMatchObject({code:'23505'});
    const rows=await db.selectFrom('aml_cdd_cases').select(['id','version']).where('client_id','=',clientId).execute();expect(rows).toHaveLength(1);expect(rows[0]!.version).toBe(1);
  });

  it('binds ciphertext contexts to record ids and requires case-local graph nodes',async()=>{
    const caseId=await createCase(await client());const id=randomUUID();const x=crypt(`aml-subject:${randomUUID()}`);
    await expect(sql`select app.add_aml_cdd_subject(${id},${caseId},'legal_entity','client',${x.context},${x.key}::smallint,${x.nonce},${x.ciphertext},${x.tag},${partner.id})`.execute(db)).rejects.toMatchObject({code:'23514'});
  });

  it('rejects future-dated evidence and identity checks in PostgreSQL',async()=>{
    const caseId=await createCase(await client());const id=randomUUID();const x=crypt(`aml-evidence-metadata:${id}`);
    await expect(sql`select app.add_aml_cdd_evidence(${id},${caseId},'passport','GB'::char(2),'2099-01-01'::date,null,${x.context},${x.key}::smallint,${x.nonce},${x.ciphertext},${x.tag},'application/pdf',10,${Buffer.alloc(32,3)},${`compliance/${randomUUID()}`},1::smallint,${Buffer.alloc(12,4)},${Buffer.alloc(32,5)},${Buffer.alloc(16,6)},${partner.id})`.execute(db)).rejects.toMatchObject({code:'23514'});
  });
});
