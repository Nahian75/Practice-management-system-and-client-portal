import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { AuditService } from '../audit/audit.service.js';
import type { TaskActor } from '../tasks/tasks.service.js';
import { visibleTo } from '../matters/matters.repository.js';

interface TimerRow { timer_id: string; revision: string; elapsed_ms: string; started_at: Date | null }
export interface TimerState { timerId: string | null; revision: string | null; elapsedMs: number; startedAt: string | null; serverNow: string }
const MAX_ELAPSED_MS = 365 * 86400000;
const conflict = () => new ConflictException('The timer changed on another tab or device. Reload it and try again');

@Injectable()
export class WorkTimerService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>, private readonly audit: AuditService) {}

  private async row(accountId: string, db: Kysely<Database>) {
    return (await sql<TimerRow>`SELECT timer_id,revision,elapsed_ms,started_at FROM app.work_timers
      WHERE account_id=${accountId}::uuid`.execute(db)).rows[0];
  }
  private state(row: TimerRow | undefined): TimerState {
    return { timerId: row?.timer_id ?? null, revision: row?.revision ?? null, elapsedMs: Number(row?.elapsed_ms ?? 0),
      startedAt: row?.started_at?.toISOString() ?? null, serverNow: new Date().toISOString() };
  }
  async get(accountId: string) { return this.state(await this.row(accountId, this.db)); }

  async change(action: 'start' | 'pause' | 'reset', revision: string | null, by: TaskActor) {
    return this.db.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`work-timer:${by.accountId}`},0))`.execute(trx);
      const row = await this.row(by.accountId, trx);
      if ((row?.revision ?? null) !== revision) throw conflict();
      const now = new Date();
      const elapsed = Math.min(MAX_ELAPSED_MS, Number(row?.elapsed_ms ?? 0) + (row?.started_at ? Math.max(0, now.getTime()-row.started_at.getTime()) : 0));
      if ((action === 'start' && row?.started_at) || (action === 'pause' && !row?.started_at)) return this.state(row);
      const timerId = action === 'reset' || !row ? randomUUID() : row.timer_id;
      const nextRevision = randomUUID();
      await sql`INSERT INTO app.work_timers(account_id,timer_id,revision,elapsed_ms,started_at)
        VALUES(${by.accountId}::uuid,${timerId}::uuid,${nextRevision}::uuid,${action==='reset'?0:elapsed},${action==='start'?now:null})
        ON CONFLICT(account_id) DO UPDATE SET timer_id=EXCLUDED.timer_id,revision=EXCLUDED.revision,
          elapsed_ms=EXCLUDED.elapsed_ms,started_at=EXCLUDED.started_at`.execute(trx);
      await this.audit.record({actor:by.actor,action:`timer.${action}`,outcome:'success',resource:{type:'work_timer',id:timerId},...by.context},trx);
      return this.state(await this.row(by.accountId,trx));
    });
  }

  async record(input: {timerId:string; revision:string; matterId:string; workedOn:string; minutes:number; description:string}, by:TaskActor) {
    const digest=createHash('sha256').update(JSON.stringify([input.matterId,input.workedOn,input.minutes,input.description])).digest('hex');
    try {
      return await this.db.transaction().execute(async trx=>{
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`work-timer:${by.accountId}`},0))`.execute(trx);
        // Recheck access even for a replay: a receipt must not reveal an inaccessible matter.
        const matter=await trx.selectFrom('matters').select('id').where('id','=',input.matterId).where(visibleTo(by.accountId)).executeTakeFirst();
        if(!matter)throw new NotFoundException('No matter with this id');
        const receipt=(await sql<{time_entry_id:string;request_sha256:string}>`SELECT time_entry_id,request_sha256 FROM app.work_timer_receipts
          WHERE timer_id=${input.timerId}::uuid AND account_id=${by.accountId}::uuid`.execute(trx)).rows[0];
        if(receipt){if(receipt.request_sha256!==digest)throw conflict();return {id:receipt.time_entry_id};}
        const row=await this.row(by.accountId,trx);
        if(!row||row.timer_id!==input.timerId||row.revision!==input.revision||row.started_at||Number(row.elapsed_ms)<=0)throw conflict();
        if(Number(row.elapsed_ms)>86400000)throw new ConflictException('The timer exceeds one work day. Record separate daily entries manually before resetting it');
        const entry=await trx.insertInto('time_entries').values({matter_id:input.matterId,worker_id:by.accountId,
          recorded_by:by.accountId,worked_on:input.workedOn,minutes:input.minutes,description:input.description}).returning('id').executeTakeFirstOrThrow();
        await sql`INSERT INTO app.work_timer_receipts(timer_id,account_id,time_entry_id,request_sha256)
          VALUES(${input.timerId}::uuid,${by.accountId}::uuid,${entry.id}::uuid,${digest})`.execute(trx);
        await sql`UPDATE app.work_timers SET timer_id=${randomUUID()}::uuid,revision=${randomUUID()}::uuid,elapsed_ms=0,started_at=NULL
          WHERE account_id=${by.accountId}::uuid`.execute(trx);
        await this.audit.record({actor:by.actor,action:'time.recorded',outcome:'success',resource:{type:'time_entry',id:entry.id},
          metadata:{matterId:input.matterId,minutes:input.minutes,timerId:input.timerId},...by.context},trx);
        return {id:entry.id};
      });
    }catch(error){
      if((error as {code?:string}).code==='23514')throw new ConflictException('Check the matter clearance, work date and staff rate before recording time');
      throw error;
    }
  }
}
