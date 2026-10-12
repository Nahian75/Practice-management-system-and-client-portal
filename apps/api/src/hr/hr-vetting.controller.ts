import { BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { HrVettingService, type HrVettingChange } from './hr-vetting.service.js';
import { HrService, type HrActor } from './hr.service.js';

const id=z.uuid(),date=z.iso.date(),dateTime=z.iso.datetime({ offset:true });
const changeSchema=z.object({ id,version:z.number().int().optional() });
const itemBody=z.strictObject({ code:z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),title:text(200),
  ownerKind:z.enum(['hr','administrator','manager','worker','other_module']),required:z.boolean(),
  dueOn:date.nullable().optional() }).transform((value)=>({ ...value,dueOn:value.dueOn??null }));
const checklistBody=z.strictObject({ engagementId:id,kind:z.enum(['joiner','mover','leaver']),effectiveOn:date,
  reasonCategory:z.enum(['resignation','dismissal','redundancy','retirement','end_of_fixed_term','transfer','other'])
    .nullable().optional(),items:z.array(itemBody).min(1).max(50) }).transform((value)=>({ ...value,
      reasonCategory:value.reasonCategory??null })).refine((value)=>value.kind==='leaver'
        ? value.reasonCategory!==null : value.reasonCategory===null,'Only a leaver checklist has a reason category')
    .refine((value)=>new Set(value.items.map((item)=>item.code)).size===value.items.length,'Checklist item codes must be unique');
const eventBody=z.strictObject({ action:z.enum(['completed','reopened']),note:text(10_000,3) });
const rtwBody=z.strictObject({ engagementId:id,guidanceVersion:text(200),checkRoute:z.enum(['manual','online','digital_provider']),
  checkedOn:date,permissionType:z.enum(['british_or_irish','settled','pre_settled','time_limited','other']),
  result:z.enum(['passed','failed','follow_up_required']),expiresOn:date.nullable().optional(),
  followUpOn:date.nullable().optional(),evidenceFileId:id,identityMatchMethod:text(500),
  workRestrictions:text(10_000,3).nullable().optional(),providerReference:text(500).nullable().optional() })
  .transform((value)=>({ ...value,expiresOn:value.expiresOn??null,followUpOn:value.followUpOn??null,
    workRestrictions:value.workRestrictions??null,providerReference:value.providerReference??null }))
  .refine((value)=>value.permissionType!=='time_limited'||value.expiresOn!==null,'Time-limited permission needs an expiry date');
const professionalBody=z.strictObject({ kind:z.enum(['qualification','professional_registration','practising_certificate']),
  title:text(200),issuer:text(200),validFrom:date.nullable().optional(),validTo:date.nullable().optional(),
  identifier:text(500).nullable().optional(),restriction:text(10_000,3).nullable().optional() })
  .transform((value)=>({ ...value,validFrom:value.validFrom??null,validTo:value.validTo??null,
    identifier:value.identifier??null,restriction:value.restriction??null }));
const professionalCheckBody=z.strictObject({ status:z.enum(['current','expired','restricted','suspended','not_verified']),
  checkedOn:date,source:text(500),note:text(10_000,3).nullable().optional() })
  .transform((value)=>({ ...value,note:value.note??null }));

const lifecycleSchema=z.object({ checklists:z.array(z.object({ id,engagementId:id,kind:z.enum(['joiner','mover','leaver']),
  effectiveOn:date,reasonCategory:z.string().nullable(),state:z.enum(['open','completed','reopened']),
  items:z.array(z.object({ id,code:z.string(),title:z.string(),ownerKind:z.string(),required:z.boolean(),
    dueOn:date.nullable(),state:z.enum(['open','completed','reopened']) })) })) });
const blockerSchema=z.object({ blockers:z.array(z.object({ kind:z.string(),resourceId:id,status:z.string() })) });
const professionalSchema=z.object({ id,personId:id,kind:z.enum(['qualification','professional_registration','practising_certificate']),
  title:z.string(),issuer:z.string(),validFrom:date.nullable(),validTo:date.nullable(),identifier:z.string().nullable(),
  restriction:z.string().nullable(),status:z.enum(['current','expired','restricted','suspended','not_verified']).nullable(),
  checkedOn:date.nullable(),source:z.string().nullable(),checkNote:z.string().nullable(),recordedBy:id,
  recordedAt:dateTime,checkedBy:id.nullable(),checkRecordedAt:dateTime.nullable() });
const vettingSchema=z.object({ rightToWork:z.array(z.object({ id,engagementId:id,version:z.number().int(),
  result:z.enum(['passed','failed','follow_up_required']).nullable(),
  permissionType:z.enum(['british_or_irish','settled','pre_settled','time_limited','other']).nullable(),
  checkedOn:date.nullable(),expiresOn:date.nullable(),followUpOn:date.nullable(),overdue:z.boolean(),actionRequired:z.boolean() })),
  rightToWorkChecks:z.array(z.object({ id,engagementId:id,version:z.number().int(),previousCheckId:id.nullable(),
    guidanceVersion:z.string(),checkRoute:z.enum(['manual','online','digital_provider']),checkedOn:date,
    permissionType:z.enum(['british_or_irish','settled','pre_settled','time_limited','other']),
    result:z.enum(['passed','failed','follow_up_required']),expiresOn:date.nullable(),followUpOn:date.nullable(),
    evidenceFileId:id,details:z.object({ identityMatchMethod:z.string(),workRestrictions:z.string().nullable(),
      providerReference:z.string().nullable() }),checkedBy:id,recordedAt:dateTime })),professional:z.array(professionalSchema) });
const dueSchema=z.object({ checks:z.array(z.object({ personId:id,accountId:id,displayName:z.string(),checkId:id,
  engagementId:id,result:z.enum(['passed','failed','follow_up_required']),expiresOn:date.nullable(),
  followUpOn:date.nullable(),overdue:z.boolean() })) });

@Controller('hr')
export class HrVettingController {
  constructor(private readonly vetting:HrVettingService,private readonly hr:HrService) {}

  @Get('me/lifecycle') @StaffOnly() @ResponseSchema(lifecycleSchema)
  async ownLifecycle(@CurrentSession() session:ResolvedSession) {
    return foundLifecycle(await this.vetting.lifecycle(await this.ownPerson(session.account.id),session.account.id));
  }
  @Get('reports/:personId/lifecycle') @StaffOnly() @ResponseSchema(lifecycleSchema)
  async reportLifecycle(@Param('personId',{ schema:id }) personId:string,@CurrentSession() session:ResolvedSession) {
    return foundLifecycle(await this.vetting.lifecycle(personId,session.account.id));
  }
  @Get('people/:personId/lifecycle') @RequirePermission('hr.manage') @ResponseSchema(lifecycleSchema)
  async lifecycle(@Param('personId',{ schema:id }) personId:string,@CurrentSession() session:ResolvedSession) {
    return foundLifecycle(await this.vetting.lifecycle(personId,session.account.id));
  }
  @Post('people/:personId/lifecycle') @RequirePermission('hr.manage') @ResponseSchema(changeSchema)
  async createLifecycle(@Param('personId',{ schema:id }) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.createChecklist(personId,parse(checklistBody,request.body),actorFor(session,request)));
  }
  @Post('lifecycle/items/:itemId/events') @RequirePermission('hr.manage') @ResponseSchema(changeSchema)
  async itemEvent(@Param('itemId',{ schema:id }) itemId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.recordItemEvent(itemId,parse(eventBody,request.body),actorFor(session,request)));
  }
  @Post('lifecycle/:checklistId/events') @RequirePermission('hr.manage') @ResponseSchema(changeSchema)
  async checklistEvent(@Param('checklistId',{ schema:id }) checklistId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.recordChecklistEvent(checklistId,parse(eventBody,request.body),actorFor(session,request)));
  }
  @Get('lifecycle/:checklistId/blockers') @RequirePermission('hr.manage') @ResponseSchema(blockerSchema)
  async blockers(@Param('checklistId',{ schema:id }) checklistId:string,@CurrentSession() session:ResolvedSession) {
    const blockers=await this.vetting.blockers(checklistId,session.account.id);
    if (!blockers) throw new NotFoundException('The lifecycle checklist is not available');
    return { blockers };
  }

  @Get('me/vetting') @StaffOnly() @ResponseSchema(vettingSchema)
  async ownVetting(@Req() request:Request,@CurrentSession() session:ResolvedSession) {
    return found(await this.vetting.vetting(await this.ownPerson(session.account.id),actorFor(session,request),'self'));
  }
  @Get('reports/:personId/vetting') @StaffOnly() @ResponseSchema(vettingSchema)
  async reportVetting(@Param('personId',{ schema:id }) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return found(await this.vetting.vetting(personId,actorFor(session,request),'manager'));
  }
  @Get('people/:personId/vetting') @RequirePermission('hr.vetting') @ResponseSchema(vettingSchema)
  async personVetting(@Param('personId',{ schema:id }) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return found(await this.vetting.vetting(personId,actorFor(session,request),'hr'));
  }
  @Get('vetting/due') @RequirePermission('hr.vetting') @ResponseSchema(dueSchema)
  async due(@CurrentSession() session:ResolvedSession) { return { checks:await this.vetting.due(session.account.id) }; }
  @Post('people/:personId/right-to-work') @RequirePermission('hr.vetting') @ResponseSchema(changeSchema)
  async rightToWork(@Param('personId',{ schema:id }) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.recordRightToWork(personId,parse(rtwBody,request.body),actorFor(session,request)));
  }
  @Post('people/:personId/professional-records') @RequirePermission('hr.competence') @ResponseSchema(changeSchema)
  async professional(@Param('personId',{ schema:id }) personId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.createProfessional(personId,parse(professionalBody,request.body),actorFor(session,request)));
  }
  @Post('professional-records/:recordId/checks') @RequirePermission('hr.competence') @ResponseSchema(changeSchema)
  async professionalCheck(@Param('recordId',{ schema:id }) recordId:string,@Req() request:Request,
    @CurrentSession() session:ResolvedSession) {
    return changed(await this.vetting.recordProfessionalCheck(recordId,parse(professionalCheckBody,request.body),
      actorFor(session,request)));
  }

  private async ownPerson(accountId:string) {
    const personId=await this.hr.ownPersonId(accountId);
    if (!personId) throw new NotFoundException('No HR record is available for your account');
    return personId;
  }
}

function actorFor(session:ResolvedSession,request:Request):HrActor {
  return { actor:auditActorFor(session.account),accountId:session.account.id,context:requestContext(request) };
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Give valid HR lifecycle or vetting details');
  return result.data;
}
function changed<T>(result:HrVettingChange<T>):T {
  if (result.outcome==='changed') return json(result.value);
  if (result.outcome==='not_found') throw new NotFoundException('The HR record is not available');
  throw new ConflictException('The HR record cannot be changed in its current state');
}
function foundLifecycle<T>(checklists:T[]|undefined) {
  if (!checklists) throw new NotFoundException('The HR lifecycle record is not available');
  return json({ checklists });
}
function found<T>(value:T|undefined):T {
  if (!value) throw new NotFoundException('The HR vetting record is not available');
  return json(value);
}
function json<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
