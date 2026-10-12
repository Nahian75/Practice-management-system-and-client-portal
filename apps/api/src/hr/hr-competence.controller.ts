import { BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { HrCompetenceService, type HrCompetenceChange } from './hr-competence.service.js';
import { HrService, type HrActor } from './hr.service.js';

const id=z.uuid(),date=z.iso.date(),dateTime=z.iso.datetime({offset:true});
const cycleBody=z.strictObject({title:text(200),periodStart:date,periodEnd:date})
  .refine((value)=>value.periodEnd>=value.periodStart,'The development period must end on or after it starts');
const developmentEventBody=z.strictObject({kind:z.enum(['reflection','need','plan','activity','evaluation','review','requirement','status']),
  state:z.enum(['planned','active','completed','closed']).nullable().optional(),narrative:text(10_000,3),
  evidenceReference:text(1000).nullable().optional()}).transform((value)=>({...value,state:value.state??null,
    evidenceReference:value.evidenceReference??null})).refine((value)=>(value.kind==='status')===(value.state!==null),
      'Only a status event has a state');
const learningBody=z.strictObject({title:text(200),provider:text(200).nullable().optional(),dueOn:date,details:text(10_000,3)})
  .transform((value)=>({...value,provider:value.provider??null}));
const learningEventBody=z.strictObject({action:z.enum(['completed','reopened']),completedOn:date.nullable().optional(),
  note:text(10_000,3),evidenceReference:text(1000).nullable().optional()}).transform((value)=>({...value,
    completedOn:value.completedOn??null,evidenceReference:value.evidenceReference??null})).refine((value)=>
      (value.action==='completed')===(value.completedOn!==null),'Only completion has a completion date');
const reviewBody=z.strictObject({kind:z.enum(['objective','appraisal']),title:text(200),
  periodStart:date.nullable().optional(),periodEnd:date.nullable().optional(),targetOn:date.nullable().optional(),
  statement:text(20_000,3)}).transform((value)=>({...value,periodStart:value.periodStart??null,
    periodEnd:value.periodEnd??null,targetOn:value.targetOn??null})).refine((value)=>value.kind==='objective'
      ? value.targetOn!==null&&value.periodStart===null&&value.periodEnd===null
      : value.targetOn===null&&value.periodStart!==null&&value.periodEnd!==null&&value.periodEnd>=value.periodStart,
    'Give a target for an objective or a valid period for an appraisal');
const workerEventBody=z.strictObject({action:z.enum(['acknowledged','response','disagreement']),
  note:text(10_000,3).nullable().optional()}).transform((value)=>({...value,note:value.note??null}))
  .refine((value)=>value.action==='acknowledged'||value.note!==null,'A response or disagreement needs text');
const changeSchema=z.object({id});
const sealedEvent=z.object({id,recordedBy:id,recordedAt:dateTime});
const competenceSchema=z.object({
  development:z.array(z.object({id,title:z.string(),periodStart:date,periodEnd:date,createdBy:id,createdAt:dateTime,
    events:z.array(sealedEvent.extend({kind:z.enum(['reflection','need','plan','activity','evaluation','review','requirement','status']),
      state:z.enum(['planned','active','completed','closed']).nullable(),narrative:z.string(),evidenceReference:z.string().nullable()}))})),
  learning:z.array(z.object({id,title:z.string(),provider:z.string().nullable(),dueOn:date,details:z.string(),
    assignedBy:id,assignedAt:dateTime,events:z.array(sealedEvent.extend({action:z.enum(['completed','reopened']),
      completedOn:date.nullable(),note:z.string(),evidenceReference:z.string().nullable()}))})),
  reviews:z.array(z.object({id,kind:z.enum(['objective','appraisal']),title:z.string(),periodStart:date.nullable(),
    periodEnd:date.nullable(),targetOn:date.nullable(),statement:z.string(),recordedBy:id,recordedAt:dateTime,
    workerEvents:z.array(sealedEvent.extend({action:z.enum(['acknowledged','response','disagreement']),note:z.string().nullable()}))})),
  amlTraining:z.array(z.object({materialId:id,title:z.string(),version:z.number().int(),completedOn:date.nullable(),
    dueOn:date,status:z.enum(['completed','due','expired'])})) });

@Controller('hr')
export class HrCompetenceController {
  constructor(private readonly competence:HrCompetenceService,private readonly hr:HrService) {}
  @Get('me/competence') @StaffOnly() @ResponseSchema(competenceSchema)
  own(@Req() request:Request,@CurrentSession() session:ResolvedSession){return this.read(
    this.ownPerson(session.account.id),actorFor(session,request),false);}
  @Get('reports/:personId/competence') @StaffOnly() @ResponseSchema(competenceSchema)
  report(@Param('personId',{schema:id}) personId:string,@Req() request:Request,@CurrentSession() session:ResolvedSession){
    return this.read(Promise.resolve(personId),actorFor(session,request),false);}
  @Get('people/:personId/competence') @RequirePermission('hr.competence') @ResponseSchema(competenceSchema)
  person(@Param('personId',{schema:id}) personId:string,@Req() request:Request,@CurrentSession() session:ResolvedSession){
    return this.read(Promise.resolve(personId),actorFor(session,request),true);}

  @Post('me/development') @StaffOnly() @ResponseSchema(changeSchema)
  async ownCycle(@Req() request:Request,@CurrentSession() session:ResolvedSession){return changed(await this.competence.createCycle(
    await this.ownPerson(session.account.id),parse(cycleBody,request.body),actorFor(session,request)));}
  @Post('reports/:personId/development') @StaffOnly() @ResponseSchema(changeSchema)
  async reportCycle(@Param('personId',{schema:id}) personId:string,@Req() request:Request,@CurrentSession() session:ResolvedSession){
    return changed(await this.competence.createCycle(personId,parse(cycleBody,request.body),actorFor(session,request)));}
  @Post('people/:personId/development') @RequirePermission('hr.competence') @ResponseSchema(changeSchema)
  async personCycle(@Param('personId',{schema:id}) personId:string,@Req() request:Request,@CurrentSession() session:ResolvedSession){
    return changed(await this.competence.createCycle(personId,parse(cycleBody,request.body),actorFor(session,request)));}
  @Post('development/:cycleId/events') @StaffOnly() @ResponseSchema(changeSchema)
  async developmentEvent(@Param('cycleId',{schema:id}) cycleId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession){return changed(await this.competence.developmentEvent(cycleId,
      parse(developmentEventBody,request.body),actorFor(session,request)));}

  @Post('people/:personId/learning-assignments') @RequirePermission('hr.competence') @ResponseSchema(changeSchema)
  async learning(@Param('personId',{schema:id}) personId:string,@Req() request:Request,@CurrentSession() session:ResolvedSession){
    return changed(await this.competence.assignLearning(personId,parse(learningBody,request.body),actorFor(session,request)));}
  @Post('learning-assignments/:assignmentId/events') @StaffOnly() @ResponseSchema(changeSchema)
  async learningEvent(@Param('assignmentId',{schema:id}) assignmentId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession){return changed(await this.competence.learningEvent(assignmentId,
      parse(learningEventBody,request.body),actorFor(session,request)));}

  @Post('reports/:personId/reviews') @StaffOnly() @ResponseSchema(changeSchema)
  async reportReview(@Param('personId',{schema:id}) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession){return changed(await this.competence.createReview(personId,
      parse(reviewBody,request.body),actorFor(session,request)));}
  @Post('people/:personId/reviews') @RequirePermission('hr.competence') @ResponseSchema(changeSchema)
  async personReview(@Param('personId',{schema:id}) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession){return changed(await this.competence.createReview(personId,
      parse(reviewBody,request.body),actorFor(session,request)));}
  @Post('reviews/:reviewId/worker-events') @StaffOnly() @ResponseSchema(changeSchema)
  async reviewEvent(@Param('reviewId',{schema:id}) reviewId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession){return changed(await this.competence.reviewEvent(reviewId,
      parse(workerEventBody,request.body),actorFor(session,request)));}

  private async ownPerson(accountId:string){const personId=await this.hr.ownPersonId(accountId);
    if(!personId)throw new NotFoundException('No HR record is available for your account');return personId;}
  private async read(person:Promise<string>,by:HrActor,hrView:boolean){const value=await this.competence.competence(await person,by,hrView);
    if(!value)throw new NotFoundException('The HR competence record is not available');return json(value);}
}
function actorFor(session:ResolvedSession,request:Request):HrActor{return{actor:auditActorFor(session.account),
  accountId:session.account.id,context:requestContext(request)};}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);
  if(!result.success)throw new BadRequestException('Give valid HR competence details');return result.data;}
function changed<T>(result:HrCompetenceChange<T>):T{if(result.outcome==='changed')return json(result.value);
  if(result.outcome==='not_found')throw new NotFoundException('The HR competence record is not available');
  throw new ConflictException('The HR competence record cannot be changed in its current state');}
function json<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T;}
