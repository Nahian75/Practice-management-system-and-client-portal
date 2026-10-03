import {
  Injectable,
  StandardSchemaSerializerInterceptor,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

export class MissingResponseSchemaError extends Error {
  override readonly name = 'MissingResponseSchemaError';
}

/**
 * Nest's interceptor returns the handler's result untouched when no schema is
 * declared. This one refuses to run the handler at all, so every route must
 * state exactly which fields it may send.
 */
@Injectable()
export class StrictSchemaSerializerInterceptor extends StandardSchemaSerializerInterceptor {
  // No default schema on purpose: a fallback would let routes skip declaring their own.
  constructor(reflector: Reflector) {
    super(reflector);
  }

  override intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.getContextOptions(context)?.schema) {
      throw new MissingResponseSchemaError(
        `${context.getClass().name}.${context.getHandler().name} has no response schema`,
      );
    }

    return super.intercept(context, next);
  }
}
