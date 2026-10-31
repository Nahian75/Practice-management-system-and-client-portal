import { Body,Controller,Get,Post,Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { CurrentSession,auditActorFor,type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { requestContext } from '../common/http/request-context.js';
import { text } from '../common/validation/safe-text.js';
import { WorkTimerService } from './work-timer.service.js';

const state=z.object({timerId:z.uuid().nullable(),revision:z.uuid().nullable(),elapsedMs:z.number().nonnegative(),startedAt:z.iso.datetime().nullable(),serverNow:z.iso.datetime()});
const change=z.strictObject({action:z.enum(['start','pause','reset']),revision:z.uuid().nullable()});
const record=z.strictObject({timerId:z.uuid(),revision:z.uuid(),matterId:z.uuid(),workedOn:z.iso.date(),minutes:z.number().int().min(1).max(1440),description:text(1000)});
const actor=(s:ResolvedSession,r:Request)=>({actor:auditActorFor(s.account),accountId:s.account.id,context:requestContext(r)});
@Controller('workspace/timer')
export class WorkTimerController {
  constructor(private readonly timers:WorkTimerService){}
  @Get() @RequirePermission('time.record') @ResponseSchema(state)
  get(@CurrentSession()s:ResolvedSession){return this.timers.get(s.account.id);}
  @Post() @RequirePermission('time.record') @ResponseSchema(state)
  change(@Body({schema:change})body:z.infer<typeof change>,@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.timers.change(body.action,body.revision,actor(s,r));}
  @Post('record') @RequirePermission('time.record') @ResponseSchema(z.object({id:z.uuid()}))
  record(@Body({schema:record})body:z.infer<typeof record>,@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.timers.record(body,actor(s,r));}
}
