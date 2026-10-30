import { Controller, Get, Res } from '@nestjs/common';
import type {Response} from 'express';
import {ReadinessService} from './readiness.service.js';
import { z } from 'zod';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { Public } from '../auth/sessions/access.decorators.js';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

type HealthResponse = z.infer<typeof healthResponseSchema>;

@Public()
@Controller()
export class HealthController {
  constructor(private readonly readiness:ReadinessService) {}
  @Get('ready')
  @ResponseSchema(z.object({status:z.enum(['ok','unavailable'])}))
  async ready(@Res({passthrough:true})response:Response) {
    const ready=await this.readiness.ready();
    response.status(ready?200:503);
    return {status:ready?'ok':'unavailable'};
  }
  @Get('health')
  @ResponseSchema(healthResponseSchema)
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
