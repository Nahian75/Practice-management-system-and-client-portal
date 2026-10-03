import { SerializeOptions } from '@nestjs/common';
import type { z } from 'zod';

export const ResponseSchema = (schema: z.ZodType) => SerializeOptions({ schema });
