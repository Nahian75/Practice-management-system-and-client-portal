import {
  Injectable,
  StandardSchemaValidationPipe,
  type ArgumentMetadata,
  type Paramtype,
} from '@nestjs/common';

const SOURCES_REQUIRING_SCHEMA: ReadonlySet<Paramtype> = new Set(['body', 'query', 'param']);

export class MissingRequestSchemaError extends Error {
  override readonly name = 'MissingRequestSchemaError';
}

/**
 * Nest's pipe passes a value through unvalidated when the route declares no
 * schema. This one refuses instead, so a forgotten schema fails loudly.
 */
@Injectable()
export class StrictSchemaValidationPipe extends StandardSchemaValidationPipe {
  override async transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
    if (SOURCES_REQUIRING_SCHEMA.has(metadata.type) && !metadata.schema) {
      throw new MissingRequestSchemaError(
        `@${metadata.type}(${metadata.data ?? ''}) has no schema`,
      );
    }

    return super.transform(value, metadata);
  }
}
