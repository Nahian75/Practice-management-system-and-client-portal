import { Body,Controller,Get,Post,Put,Param,Query,Req,HttpCode } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { CurrentSession,auditActorFor,type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { ResponseSchema,NO_CONTENT } from '../common/serialization/response-schema.decorator.js';
import { requestContext } from '../common/http/request-context.js';
import { text } from '../common/validation/safe-text.js';
import { WorkspaceService } from './workspace.service.js';

const baseQuery={q:z.string().trim().max(100).optional(),before:z.uuid().optional(),from:z.iso.date().optional(),to:z.iso.date().optional()};
const listQuery=z.strictObject(baseQuery);
const taskQuery=z.strictObject({...baseQuery,status:z.enum(['open','completed','cancelled','all']).default('open'),assignee:z.enum(['me','all']).default('all')});
const matterFields={id:z.uuid(),matterId:z.uuid(),matterReference:z.string(),matterTitle:z.string()};
const page=<T extends z.ZodType>(item:T)=>z.object({items:z.array(item),next:z.uuid().nullable()});
const task=z.object({...matterFields,title:z.string(),status:z.enum(['open','completed','cancelled']),priority:z.enum(['low','normal','high','urgent']),dueOn:z.iso.date().nullable(),assignee:z.string(),assigneeId:z.uuid()});
const doc=z.object({...matterFields,title:z.string(),category:z.string(),sharedWithClient:z.boolean(),version:z.number().int(),fileName:z.string(),sizeBytes:z.number(),uploadedAt:z.iso.datetime()});
const activity=z.object({...matterFields,description:z.string(),workedOn:z.iso.date(),minutes:z.number().int(),voided:z.boolean(),worker:z.string()});
const range=z.strictObject({from:z.iso.date(),to:z.iso.date()}).refine(v=>Date.parse(v.to)>=Date.parse(v.from)&&Date.parse(v.to)-Date.parse(v.from)<=93*86400000,'Choose a date range of at most 93 days');
const newEvent=z.strictObject({title:text(200),description:text(2000).nullable().optional(),matterId:z.uuid().nullable().optional(),startsAt:z.iso.datetime(),endsAt:z.iso.datetime()})
  .refine(v=>v.startsAt>='1900'&&v.endsAt<'2101'&&Date.parse(v.endsAt)>Date.parse(v.startsAt)&&Date.parse(v.endsAt)-Date.parse(v.startsAt)<=30*86400000,'End must follow the start, within 30 days');
const event=z.object({id:z.uuid(),title:z.string(),description:z.string().nullable(),startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),matterId:z.uuid().nullable(),matterReference:z.string().nullable()});
const actor=(s:ResolvedSession,r:Request)=>({actor:auditActorFor(s.account),accountId:s.account.id,context:requestContext(r)});
const metricSchema=z.object({scope:z.enum(['personal','firm']),asOf:z.iso.date(),dailyTargetMinutes:z.number().int().nullable(),periods:z.array(z.object({key:z.string(),label:z.string(),from:z.iso.date(),to:z.iso.date(),minutes:z.number().nonnegative(),targetMinutes:z.number().nonnegative().nullable(),billedPence:z.string().regex(/^\d+$/),unbilledPence:z.string().regex(/^\d+$/)}))});

@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspace:WorkspaceService){}
  @Get('performance') @RequirePermission('time.record') @ResponseSchema(metricSchema)
  performance(@CurrentSession()s:ResolvedSession){return this.workspace.performance(s.account.id);}
  @Get('firm-performance') @RequirePermission('finance.view_all') @ResponseSchema(metricSchema)
  firmPerformance(@CurrentSession()s:ResolvedSession){return this.workspace.performance(s.account.id,'firm');}
  @Put('performance-target') @RequirePermission('time.record') @HttpCode(204) @ResponseSchema(NO_CONTENT)
  setTarget(@Body({schema:z.strictObject({dailyTargetMinutes:z.number().int().min(15).max(1440).nullable()})})body:{dailyTargetMinutes:number|null},@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.workspace.setTarget(s.account.id,body.dailyTargetMinutes,actor(s,r));}
  @Get('billing-metrics') @RequirePermission('finance.view_all') @ResponseSchema(z.object({draftCount:z.number().int(),draftPence:z.string().regex(/^\d+$/),issuedCount:z.number().int(),issuedPence:z.string().regex(/^\d+$/),creditCount:z.number().int(),creditPence:z.string().regex(/^\d+$/)}))
  billingMetrics(){return this.workspace.billingMetrics();}
  @Get('billing-records') @RequirePermission('finance.view_all') @ResponseSchema(page(z.object({id:z.uuid(),reference:z.string(),matterId:z.uuid(),matterReference:z.string(),grossPence:z.string().regex(/^\d+$/),date:z.iso.date()})))
  billingRecords(@Query({schema:z.strictObject({kind:z.enum(['draft','issued','credit']).default('issued'),before:z.uuid().optional()})})q:{kind:'draft'|'issued'|'credit';before?:string}){return this.workspace.billingRecords(q.kind,q.before);}
  @Get('feed') @RequirePermission('audit.view') @ResponseSchema(z.object({events:z.array(z.object({id:z.uuid(),action:z.string(),outcome:z.string(),occurredAt:z.iso.datetime()}))}))
  feed(){return this.workspace.feed();}
  @Get('search') @RequirePermission('matters.view') @ResponseSchema(z.object({matters:z.array(z.object({id:z.uuid(),reference:z.string(),title:z.string()})),clients:z.array(z.object({id:z.uuid(),reference:z.string(),name:z.string()}))}))
  search(@Query({schema:z.strictObject({q:z.string().trim().min(2).max(100)})})q:{q:string},@CurrentSession()s:ResolvedSession){return this.workspace.search(s.account.id,q.q);}
  @Get('tasks') @RequirePermission('tasks.view') @ResponseSchema(page(task))
  tasks(@Query({schema:taskQuery})q:z.infer<typeof taskQuery>,@CurrentSession()s:ResolvedSession){return this.workspace.tasks(s.account.id,q);}
  @Get('documents') @RequirePermission('documents.view') @ResponseSchema(page(doc))
  documents(@Query({schema:listQuery})q:z.infer<typeof listQuery>,@CurrentSession()s:ResolvedSession){return this.workspace.documents(s.account.id,q);}
  @Get('activities') @RequirePermission('time.record') @ResponseSchema(page(activity))
  activities(@Query({schema:listQuery})q:z.infer<typeof listQuery>,@CurrentSession()s:ResolvedSession){return this.workspace.activities(s.account.id,q);}
  @Get('events') @RequirePermission('tasks.view') @ResponseSchema(z.object({events:z.array(event),truncated:z.boolean()}))
  events(@Query({schema:range})q:z.infer<typeof range>,@CurrentSession()s:ResolvedSession){return this.workspace.events(s.account.id,q.from,q.to);}
  @Post('events') @RequirePermission('tasks.create') @ResponseSchema(z.object({id:z.uuid()}))
  create(@Body({schema:newEvent})body:z.infer<typeof newEvent>,@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.workspace.createEvent(body,actor(s,r));}
  @Post('events/:id/cancel') @RequirePermission('tasks.create') @HttpCode(204) @ResponseSchema(NO_CONTENT)
  cancel(@Param('id',{schema:z.uuid()})id:string,@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.workspace.cancelEvent(id,actor(s,r));}
}
