import { SerializeOptions } from '@nestjs/common';
import { z } from 'zod';

export const ResponseSchema = (schema: z.ZodType) => SerializeOptions({ schema });

/** For routes that answer 204 with no body. */
export const NO_CONTENT = z.undefined();

/** For routes that write their own body, such as a file download: the handler returns nothing. */
export const STREAMED = z.undefined();
