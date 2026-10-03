import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SessionGuard } from './auth/sessions/session.guard.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { StrictSchemaSerializerInterceptor } from './common/serialization/strict-schema-serializer.interceptor.js';
import { StrictSchemaValidationPipe } from './common/validation/strict-schema-validation.pipe.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

export function configureApp(app: NestExpressApplication): void {
  // Which proxies may report the client's address. Empty means none: the
  // address is always the one the connection came from.
  app.set('trust proxy', app.get<Env>(ENV).TRUSTED_PROXIES);

  app.useSecurityHeaders();
  app.enableCsrfProtection();

  // app.get throws if AuthModule is not loaded, so the app cannot start without the guard.
  app.useGlobalGuards(app.get(SessionGuard));
  app.useGlobalPipes(new StrictSchemaValidationPipe());
  app.useGlobalInterceptors(new StrictSchemaSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
}
