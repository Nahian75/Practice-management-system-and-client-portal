import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sql,type Kysely} from 'kysely';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createDatabase} from '../../database/database.js';
import type {Database} from '../../database/schema.js';
import {testAppDatabaseUrl} from '../../../test/database.js';
import {ScheduledJobs} from './scheduled-jobs.js';

describe('cross-process scheduled jobs',()=>{
 let first:Kysely<Database>,second:Kysely<Database>;
 beforeAll(()=>{first=createDatabase(testAppDatabaseUrl(),2);second=createDatabase(testAppDatabaseUrl(),2);});
 afterAll(async()=>{await Promise.all([first.destroy(),second.destroy()]);});
 it('executes only one replica and remembers the next due time',async()=>{
  const name='test-'+randomUUID(),a=new ScheduledJobs(first),b=new ScheduledJobs(second);
  let entered!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{finish=r;});
  const work=vi.fn(async()=>{entered();await gate;return true;});
  const running=a.runDue(name,600,work);await ready;
  try{expect(await b.runDue(name,600,work)).toBe('skipped');}finally{finish();}
  expect(await running).toBe('ran');expect(await b.runDue(name,600,work)).toBe('skipped');expect(work).toHaveBeenCalledTimes(1);
 });
 it('backs off failed work and permits a durable wake/retry',async()=>{
  const name='test-'+randomUUID(),jobs=new ScheduledJobs(first);
  await expect(jobs.runDue(name,600,async()=>{throw new Error('synthetic failure');})).rejects.toThrow('synthetic failure');
  expect(await jobs.runDue(name,600,async()=>true)).toBe('skipped');
  await sql`SELECT app.wake_scheduled_job(${name})`.execute(first);
  expect(await jobs.runDue(name,600,async()=>true)).toBe('ran');
  await expect(sql`DELETE FROM app.scheduled_jobs`.execute(first)).rejects.toThrow(/permission denied/);
 });
 it('releases ownership after an actual worker process dies',async()=>{
  const name='test-'+randomUUID();
  const child=fork(fileURLToPath(new URL('../../../../../scripts/scaling/hold-job.mjs',import.meta.url)),[],{
   env:{...process.env,SCALING_TEST_DATABASE_URL:testAppDatabaseUrl(),SCALING_TEST_JOB_NAME:name},windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
  try{
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker fixture startup timed out')),5000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Worker exited before locking'));});});
   const jobs=new ScheduledJobs(second);
   expect(await jobs.runDue(name,600,async()=>true)).toBe('skipped');
   const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited;
   await vi.waitFor(async()=>expect(await jobs.runDue(name,600,async()=>true)).toBe('ran'),{timeout:3000});
  }finally{if(child.exitCode===null)child.kill();}
 });
});
