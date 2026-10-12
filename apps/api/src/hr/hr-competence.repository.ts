import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { SealedHrData } from './hr-data-cipher.js';

type Executor=Kysely<Database>;
export interface DevelopmentRow { cycle_id:string;title:string;period_start:string;period_end:string;
  created_by:string;created_at:Date;event_id:string|null;kind:string|null;state:string|null;context:string|null;
  key_version:number|null;nonce:Buffer|null;ciphertext:Buffer|null;auth_tag:Buffer|null;
  recorded_by:string|null;recorded_at:Date|null }
export interface LearningRow { assignment_id:string;title:string;provider:string|null;due_on:string;
  assignment_context:string;assignment_key_version:number;assignment_nonce:Buffer;assignment_ciphertext:Buffer;
  assignment_auth_tag:Buffer;assigned_by:string;assigned_at:Date;event_id:string|null;action:string|null;
  completed_on:string|null;event_context:string|null;event_key_version:number|null;event_nonce:Buffer|null;
  event_ciphertext:Buffer|null;event_auth_tag:Buffer|null;recorded_by:string|null;recorded_at:Date|null }
export interface ReviewRow { review_id:string;kind:'objective'|'appraisal';title:string;period_start:string|null;
  period_end:string|null;target_on:string|null;review_context:string;review_key_version:number;review_nonce:Buffer;
  review_ciphertext:Buffer;review_auth_tag:Buffer;review_recorded_by:string;review_recorded_at:Date;
  event_id:string|null;action:string|null;event_context:string|null;event_key_version:number|null;
  event_nonce:Buffer|null;event_ciphertext:Buffer|null;event_auth_tag:Buffer|null;
  event_recorded_by:string|null;event_recorded_at:Date|null }

@Injectable()
export class HrCompetenceRepository {
  constructor(@Inject(DATABASE) private readonly db:Executor) {}
  transaction<T>(work:(trx:Executor)=>Promise<T>):Promise<T>{ return this.db.transaction().execute(work); }
  async newId(executor:Executor=this.db){ return (await sql<{id:string}>`select uuidv7() id`.execute(executor)).rows[0]!.id; }
  createCycle(input:{id:string;personId:string;title:string;periodStart:string;periodEnd:string;actorId:string},executor:Executor){
    return sql`select app.create_hr_development_cycle(${input.id}::uuid,${input.personId}::uuid,${input.title},
      ${input.periodStart}::date,${input.periodEnd}::date,${input.actorId}::uuid)`.execute(executor);
  }
  developmentEvent(input:{id:string;cycleId:string;kind:string;state:string|null;sealed:SealedHrData;actorId:string},executor:Executor){
    return sql`select app.record_hr_development_event(${input.id}::uuid,${input.cycleId}::uuid,${input.kind},${input.state},
      ${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  assignLearning(input:{id:string;personId:string;title:string;provider:string|null;dueOn:string;sealed:SealedHrData;actorId:string},executor:Executor){
    return sql`select app.assign_hr_learning(${input.id}::uuid,${input.personId}::uuid,${input.title},${input.provider},
      ${input.dueOn}::date,${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},
      ${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  learningEvent(input:{id:string;assignmentId:string;action:string;completedOn:string|null;sealed:SealedHrData;actorId:string},executor:Executor){
    return sql`select app.record_hr_learning_event(${input.id}::uuid,${input.assignmentId}::uuid,${input.action},
      ${input.completedOn}::date,${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},
      ${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  createReview(input:{id:string;personId:string;kind:string;title:string;periodStart:string|null;periodEnd:string|null;
    targetOn:string|null;sealed:SealedHrData;actorId:string},executor:Executor){
    return sql`select app.create_hr_review_record(${input.id}::uuid,${input.personId}::uuid,${input.kind},${input.title},
      ${input.periodStart}::date,${input.periodEnd}::date,${input.targetOn}::date,${input.sealed.context},
      ${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},${input.sealed.authTag},
      ${input.actorId}::uuid)`.execute(executor);
  }
  reviewEvent(input:{id:string;reviewId:string;action:string;sealed:SealedHrData;actorId:string},executor:Executor){
    return sql`select app.record_hr_review_worker_event(${input.id}::uuid,${input.reviewId}::uuid,${input.action},
      ${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }
  development(personId:string,actorId:string){ return sql<DevelopmentRow>`select * from app.read_hr_development(
    ${personId}::uuid,${actorId}::uuid)`.execute(this.db).then((result)=>result.rows); }
  learning(personId:string,actorId:string){ return sql<LearningRow>`select * from app.read_hr_learning(
    ${personId}::uuid,${actorId}::uuid)`.execute(this.db).then((result)=>result.rows); }
  reviews(personId:string,actorId:string){ return sql<ReviewRow>`select * from app.read_hr_reviews(
    ${personId}::uuid,${actorId}::uuid)`.execute(this.db).then((result)=>result.rows); }
}
