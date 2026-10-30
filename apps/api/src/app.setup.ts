import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { PermissionGuard } from './auth/permissions/permission.guard.js';
import { SessionGuard } from './auth/sessions/session.guard.js';
import { SessionsService } from './auth/sessions/sessions.service.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { StrictSchemaSerializerInterceptor } from './common/serialization/strict-schema-serializer.interceptor.js';
import { StrictSchemaValidationPipe } from './common/validation/strict-schema-validation.pipe.js';
import { ENV } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DATABASE } from './database/database.module.js';
import { AccountRateGuard, RequestLimiter } from './common/http/request-limiter.js';

export function configureApp(app: NestExpressApplication): void {
  // Which proxies may report the client's address. Empty means none: the
  // address is always the one the connection came from.
  app.set('trust proxy', app.get<Env>(ENV).TRUSTED_PROXIES);

  app.useSecurityHeaders();
  // Answers carry client and staff details: the browser must not keep them, in its cache or on disk (review W2).
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCsrfProtection();
  const limiter = new RequestLimiter(app.get(DATABASE),app.get(SessionsService));
  app.use(limiter.middleware);

  // app.get throws if AuthModule is not loaded, so the app cannot start without the
  // guards. Order matters: the PermissionGuard reads the session the SessionGuard checked.
  app.useGlobalGuards(app.get(SessionGuard), new AccountRateGuard(limiter), app.get(PermissionGuard));
  app.useGlobalPipes(new StrictSchemaValidationPipe());
  app.useGlobalInterceptors(new StrictSchemaSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
}
