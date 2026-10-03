import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { StrictSchemaSerializerInterceptor } from './common/serialization/strict-schema-serializer.interceptor.js';
import { StrictSchemaValidationPipe } from './common/validation/strict-schema-validation.pipe.js';

export function configureApp(app: INestApplication): void {
  app.useSecurityHeaders();
  app.enableCsrfProtection();

  app.useGlobalPipes(new StrictSchemaValidationPipe());
  app.useGlobalInterceptors(new StrictSchemaSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
}
