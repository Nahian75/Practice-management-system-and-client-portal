import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { Public } from '../auth/sessions/access.decorators.js';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

type HealthResponse = z.infer<typeof healthResponseSchema>;

@Public()
@Controller('health')
export class HealthController {
  @Get()
  @ResponseSchema(healthResponseSchema)
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
