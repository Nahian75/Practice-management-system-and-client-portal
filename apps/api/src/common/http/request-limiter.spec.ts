import {Module,type INestApplication} from '@nestjs/common';
import {randomBytes,createHash} from 'node:crypto';
import {sql,type Kysely} from 'kysely';
import request from 'supertest';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestApp,randomTestAddress} from '../../../test/create-test-app.js';
import {DATABASE} from '../../database/database.module.js';
import type {Database} from '../../database/schema.js';
import {SessionsService} from '../../auth/sessions/sessions.service.js';
import {createTestAccount} from '../../../test/accounts.js';
@Module({})class EmptyModule{}
describe('shared API abuse limits',()=>{
 let app:INestApplication;let db:Kysely<Database>;
 beforeAll(async()=>{app=await createTestApp(EmptyModule);await app.listen(0,'127.0.0.1');db=app.get(DATABASE);});
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
 it('shares verified account budgets across replicas while preserving office access',async()=>{
   const second=await createTestApp(EmptyModule),address=randomTestAddress();
   await second.listen(0,'127.0.0.1');
   try{
     const tokens:string[]=[];
     for(let i=0;i<100;i++)tokens.push(await app.get(SessionsService).start(await createTestAccount(db,'staff'),'authenticated',{}));
     for(let round=0;round<7;round++){
       const responses=await Promise.all(tokens.map((token,i)=>request((i%2?second:app).getHttpServer()).get('/auth/session').set('Cookie',`__Host-session=${token}`).set('X-Forwarded-For',address)));
       expect(responses.every(response=>response.status===200)).toBe(true);
     }
   }finally{await second.close();}
 });
 it('does not grant the office allowance to a forged, pending or revoked session',async()=>{
   const address=randomTestAddress(),key=createHash('sha256').update(`stass-api-limit:general:${address}`).digest();
   await sql`SELECT app.consume_api_request_limit('general',${key}) FROM generate_series(1,600)`.execute(db);
   const account=await createTestAccount(db,'staff'),sessions=app.get(SessionsService);
   const pending=await sessions.start(account,'two_factor_pending',{}),valid=await sessions.start(account,'authenticated',{});
   const get=(token:string)=>request(app.getHttpServer()).get('/auth/session').set('Cookie',`__Host-session=${token}`).set('X-Forwarded-For',address);
   expect((await get(randomBytes(32).toString('base64url'))).status).toBe(429);
   expect((await get(pending)).status).toBe(429);
   expect((await get(valid)).status).toBe(200);
   await sessions.endAllForAccount(account.id,'revoked');
   expect((await get(valid)).status).toBe(429);
 });
 it('enforces one account quota across separate app instances',async()=>{
   const account=await createTestAccount(db,'staff'),token=await app.get(SessionsService).start(account,'authenticated',{});
   const key=createHash('sha256').update(`stass-api-limit:account:${account.id}`).digest();
   await sql`SELECT app.consume_api_request_limit('account',${key}) FROM generate_series(1,300)`.execute(db);
   const response=await request(app.getHttpServer()).get('/auth/session').set('Cookie',`__Host-session=${token}`);
   expect(response.status).toBe(429);expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
 });
});
