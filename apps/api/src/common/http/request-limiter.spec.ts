import {Module,type INestApplication} from '@nestjs/common';
import {randomBytes} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import request from 'supertest';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestApp,randomTestAddress} from '../../../test/create-test-app.js';
import {DATABASE} from '../../database/database.module.js';
import type {Database} from '../../database/schema.js';
@Module({})class EmptyModule{}
describe('shared API abuse limits',()=>{
 let app:INestApplication;let db:Kysely<Database>;
 beforeAll(async()=>{app=await createTestApp(EmptyModule);db=app.get(DATABASE);});
 afterAll(async()=>{await app.close();});
 it('throttles unknown-address recovery requests before database/audit work',async()=>{
   const address=randomTestAddress();
   for(let i=0;i<20;i++)expect((await request(app.getHttpServer()).post('/auth/password-reset/request').set('X-Forwarded-For',address).send({email:'absent@example.test'})).status).toBe(204);
   const limited=await request(app.getHttpServer()).post('/auth/password-reset/request').set('X-Forwarded-For',address).send({email:'absent@example.test'});
   expect(limited.status).toBe(429);expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
 });
 it('serializes a shared bucket across concurrent callers',async()=>{
   const key=randomBytes(32);
   const results=await Promise.all(Array.from({length:25},()=>sql<{allowed:boolean}>`SELECT * FROM app.consume_api_request_limit('recovery',${key})`.execute(db)));
   expect(results.filter(r=>r.rows[0]?.allowed).length).toBe(20);
 });
 it('does not grant direct table mutation to the runtime role',async()=>{
   await expect(sql`DELETE FROM app.api_request_limits`.execute(db)).rejects.toThrow(/permission denied/);
 });
});
