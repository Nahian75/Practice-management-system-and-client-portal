import { Controller, Get } from '@nestjs/common';
import { z } from 'zod';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

type HealthResponse = z.infer<typeof healthResponseSchema>;

@Controller('health')
export class HealthController {
  @Get()
  @ResponseSchema(healthResponseSchema)
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
