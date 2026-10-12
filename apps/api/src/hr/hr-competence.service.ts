import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { ComplianceTrainingStatusService } from '../compliance/compliance-training-status.service.js';
import type { Database } from '../database/schema.js';
import { HrCompetenceRepository, type DevelopmentRow, type LearningRow, type ReviewRow } from './hr-competence.repository.js';
import { HrDataCipher } from './hr-data-cipher.js';
import type { HrActor } from './hr.service.js';

export type HrCompetenceChange<T>={outcome:'changed';value:T}|{outcome:'not_found'|'conflict'};
type SealedRow={context:string;key_version:number;nonce:Buffer;ciphertext:Buffer;auth_tag:Buffer};
interface DevelopmentResult { id:string;title:string;periodStart:string;periodEnd:string;createdBy:string;createdAt:Date;
  events:Array<{id:string;kind:string;state:string|null;narrative:string;evidenceReference:string|null;
    recordedBy:string;recordedAt:Date}> }
interface LearningResult { id:string;title:string;provider:string|null;dueOn:string;details:string;assignedBy:string;
  assignedAt:Date;events:Array<{id:string;action:string;completedOn:string|null;note:string;
    evidenceReference:string|null;recordedBy:string;recordedAt:Date}> }
interface ReviewResult { id:string;kind:'objective'|'appraisal';title:string;periodStart:string|null;periodEnd:string|null;
  targetOn:string|null;statement:string;recordedBy:string;recordedAt:Date;
  workerEvents:Array<{id:string;action:string;note:string|null;recordedBy:string;recordedAt:Date}> }

@Injectable()
export class HrCompetenceService {
  constructor(private readonly records:HrCompetenceRepository,private readonly cipher:HrDataCipher,
    private readonly audit:AuditService,private readonly amlTraining:ComplianceTrainingStatusService) {}

  createCycle(personId:string,input:{title:string;periodStart:string;periodEnd:string},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.createCycle({id,personId,...input,actorId:by.accountId},trx);
      await this.log('hr.development_cycle_created','hr_development_cycle',id,{personId},by,trx); return {id}; }));
  }
  developmentEvent(cycleId:string,input:{kind:string;state:string|null;narrative:string;evidenceReference:string|null},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.developmentEvent({id,cycleId,kind:input.kind,state:input.state,
        sealed:this.cipher.seal({narrative:input.narrative,evidenceReference:input.evidenceReference},
          `hr-development-event:${id}`),actorId:by.accountId},trx);
      await this.log('hr.development_event_recorded','hr_development_cycle',cycleId,
        {kind:input.kind,...(input.state?{state:input.state}:{})},by,trx); return {id}; }));
  }
  assignLearning(personId:string,input:{title:string;provider:string|null;dueOn:string;details:string},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.assignLearning({id,personId,...input,sealed:this.cipher.seal({details:input.details},
        `hr-learning-assignment:${id}`),actorId:by.accountId},trx);
      await this.log('hr.learning_assigned','hr_learning_assignment',id,{personId,dueOn:input.dueOn},by,trx); return {id}; }));
  }
  learningEvent(assignmentId:string,input:{action:'completed'|'reopened';completedOn:string|null;
    note:string;evidenceReference:string|null},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.learningEvent({id,assignmentId,action:input.action,completedOn:input.completedOn,
        sealed:this.cipher.seal({note:input.note,evidenceReference:input.evidenceReference},
          `hr-learning-event:${id}`),actorId:by.accountId},trx);
      await this.log(`hr.learning_${input.action}`,'hr_learning_assignment',assignmentId,
        input.completedOn?{completedOn:input.completedOn}:{},by,trx); return {id}; }));
  }
  createReview(personId:string,input:{kind:'objective'|'appraisal';title:string;periodStart:string|null;
    periodEnd:string|null;targetOn:string|null;statement:string},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.createReview({id,personId,...input,sealed:this.cipher.seal({statement:input.statement},
        `hr-review-record:${id}`),actorId:by.accountId},trx);
      await this.log('hr.review_recorded','hr_review_record',id,{personId,kind:input.kind},by,trx); return {id}; }));
  }
  reviewEvent(reviewId:string,input:{action:'acknowledged'|'response'|'disagreement';note:string|null},by:HrActor){
    return this.change(async()=>this.records.transaction(async(trx)=>{ const id=await this.records.newId(trx);
      await this.records.reviewEvent({id,reviewId,action:input.action,
        sealed:this.cipher.seal({note:input.note},`hr-review-worker-event:${id}`),actorId:by.accountId},trx);
      await this.log(`hr.review_${input.action}`,'hr_review_record',reviewId,{},by,trx); return {id}; }));
  }

  async competence(personId:string,by:HrActor,hrView=false){
    try { const [development,learning,reviews,amlTraining]=await Promise.all([
      this.records.development(personId,by.accountId),this.records.learning(personId,by.accountId),
      this.records.reviews(personId,by.accountId),this.amlTraining.forHr(personId,by.accountId)]);
      if(hrView) await this.log('hr.competence_viewed','hr_person',personId,{},by);
      return {development:groupDevelopment(development,this.cipher),learning:groupLearning(learning,this.cipher),
        reviews:groupReviews(reviews,this.cipher),amlTraining};
    } catch(error){ if(hidden(error)) return undefined; throw error; }
  }
  private async change<T>(work:()=>Promise<T>):Promise<HrCompetenceChange<T>>{ try{return{outcome:'changed',value:await work()};}
    catch(error){if(hidden(error))return{outcome:'not_found'};if(['23505','23514','22007'].some((c)=>hasCode(error,c)))
      return{outcome:'conflict'};throw error;} }
  private log(action:string,type:string,id:string,metadata:Record<string,string>,by:HrActor,executor?:Kysely<Database>){
    return this.audit.record({actor:by.actor,action,outcome:'success',resource:{type,id},metadata,...by.context},executor); }
}

function open<T>(cipher:HrDataCipher,row:SealedRow):T{return cipher.open<T>({context:row.context,keyVersion:row.key_version,
  nonce:row.nonce,ciphertext:row.ciphertext,authTag:row.auth_tag});}
function groupDevelopment(rows:DevelopmentRow[],cipher:HrDataCipher){const groups=new Map<string,DevelopmentResult>();
  for(const row of rows){const cycle=groups.get(row.cycle_id)??{id:row.cycle_id,title:row.title,periodStart:row.period_start,
    periodEnd:row.period_end,createdBy:row.created_by,createdAt:row.created_at,events:[]};
    if(row.event_id&&row.kind&&row.context&&row.key_version&&row.nonce&&row.ciphertext&&row.auth_tag&&row.recorded_by&&row.recorded_at){
      const detail=open<{narrative:string;evidenceReference:string|null}>(cipher,row as SealedRow);
      cycle.events.push({id:row.event_id,kind:row.kind,state:row.state,...detail,recordedBy:row.recorded_by,recordedAt:row.recorded_at});}
    groups.set(row.cycle_id,cycle);}return[...groups.values()];}
function groupLearning(rows:LearningRow[],cipher:HrDataCipher){const groups=new Map<string,LearningResult>();for(const row of rows){
  const detail=open<{details:string}>(cipher,{context:row.assignment_context,key_version:row.assignment_key_version,
    nonce:row.assignment_nonce,ciphertext:row.assignment_ciphertext,auth_tag:row.assignment_auth_tag});
  const assignment=groups.get(row.assignment_id)??{id:row.assignment_id,title:row.title,provider:row.provider,dueOn:row.due_on,
    details:detail.details,assignedBy:row.assigned_by,assignedAt:row.assigned_at,events:[]};
  if(row.event_id&&row.action&&row.event_context&&row.event_key_version&&row.event_nonce&&row.event_ciphertext&&row.event_auth_tag
      &&row.recorded_by&&row.recorded_at){const event=open<{note:string;evidenceReference:string|null}>(cipher,
      {context:row.event_context,key_version:row.event_key_version,nonce:row.event_nonce,ciphertext:row.event_ciphertext,
        auth_tag:row.event_auth_tag});assignment.events.push({id:row.event_id,action:row.action,completedOn:row.completed_on,
        ...event,recordedBy:row.recorded_by,recordedAt:row.recorded_at});}groups.set(row.assignment_id,assignment);}return[...groups.values()];}
function groupReviews(rows:ReviewRow[],cipher:HrDataCipher){const groups=new Map<string,ReviewResult>();for(const row of rows){
  const detail=open<{statement:string}>(cipher,{context:row.review_context,key_version:row.review_key_version,
    nonce:row.review_nonce,ciphertext:row.review_ciphertext,auth_tag:row.review_auth_tag});
  const review=groups.get(row.review_id)??{id:row.review_id,kind:row.kind,title:row.title,periodStart:row.period_start,
    periodEnd:row.period_end,targetOn:row.target_on,statement:detail.statement,recordedBy:row.review_recorded_by,
    recordedAt:row.review_recorded_at,workerEvents:[]};
  if(row.event_id&&row.action&&row.event_context&&row.event_key_version&&row.event_nonce&&row.event_ciphertext&&row.event_auth_tag
      &&row.event_recorded_by&&row.event_recorded_at){const event=open<{note:string|null}>(cipher,{context:row.event_context,
      key_version:row.event_key_version,nonce:row.event_nonce,ciphertext:row.event_ciphertext,auth_tag:row.event_auth_tag});
    review.workerEvents.push({id:row.event_id,action:row.action,note:event.note,recordedBy:row.event_recorded_by,
      recordedAt:row.event_recorded_at});}groups.set(row.review_id,review);}return[...groups.values()];}
function hasCode(error:unknown,code:string){return error instanceof Error&&'code'in error&&error.code===code;}
function hidden(error:unknown){return['P0002','23503','42501'].some((code)=>hasCode(error,code));}
