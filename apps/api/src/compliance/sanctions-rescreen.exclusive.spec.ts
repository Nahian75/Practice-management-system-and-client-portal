import {Module,type INestApplication} from '@nestjs/common';
import {sql,type Kysely} from 'kysely';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestApp} from '../../test/create-test-app.js';
import {createAmlStaff,createTeamMatter,clearMatterForTests} from '../../test/aml.js';
import {DATABASE} from '../database/database.module.js';
import type {Database} from '../database/schema.js';
import {ComplianceModule} from './compliance.module.js';
import {SanctionsScreeningService} from './sanctions-screening.service.js';
@Module({imports:[ComplianceModule]})class TestRescreen{}
describe('durable pending sanctions screenings',()=>{
 let app:INestApplication,db:Kysely<Database>;
 beforeAll(async()=>{app=await createTestApp(TestRescreen);db=app.get(DATABASE);});
 afterAll(async()=>{await app.close();});
 it('resumes missing/changed work without continually rescreening current subjects',async()=>{
  const fee=await createAmlStaff(db,'fee_earner'),partner=await createAmlStaff(db,'partner');
  const {clientId,matterId}=await createTeamMatter(db,fee,partner);await clearMatterForTests(db,matterId);
  const hex=(BigInt('0x'+clientId.replaceAll('-',''))-1n).toString(16).padStart(32,'0');
  const before=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
  const pending=async()=>(await sql<{id:string}>`SELECT id FROM app.aml_pending_rescreen_clients(${before}::uuid,1) AS id`.execute(db)).rows.some(row=>row.id===clientId);
  expect(await pending()).toBe(false);
  await db.updateTable('client_individuals').set({given_names:'Changed '+randomUUID()}).where('client_id','=',clientId).execute();
  expect(await pending()).toBe(true);
  await app.get(SanctionsScreeningService).screenClient(clientId,{actor:{type:'system'},accountId:null});
  expect(await pending()).toBe(false);
 });
});
