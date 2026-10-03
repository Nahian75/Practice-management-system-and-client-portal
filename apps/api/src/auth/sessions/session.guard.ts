import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditService } from '../../audit/audit.service.js';
import { requestContext } from '../../common/http/request-context.js';
import { ACCESS_KEY, type Access } from './access.decorators.js';
import { attachSession, auditActorFor } from './authenticated-session.js';
import { readSessionToken } from './session-cookie.js';
import { SessionsService } from './sessions.service.js';

export class MissingAccessPolicyError extends Error {
  override readonly name = 'MissingAccessPolicyError';
}

/**
 * Runs before every route. A route must declare who may call it; one that
 * does not is refused, so a forgotten decorator never leaves a route open.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!access) {
      throw new MissingAccessPolicyError(
        `${context.getClass().name}.${context.getHandler().name} does not declare who may call it`,
      );
    }
    if (access === 'public') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.sessions.resolve(readSessionToken(request));

    // A session still waiting for its 2FA code is not signed in.
    if (!session || session.stage !== 'authenticated') {
      throw new UnauthorizedException();
    }

    if (access !== 'any' && access !== session.account.kind) {
      await this.audit.record({
        actor: auditActorFor(session.account),
        action: 'auth.access_denied',
        outcome: 'denied',
        metadata: { method: request.method, path: request.path, required: access },
        ...requestContext(request),
      });
      throw new ForbiddenException();
    }

    attachSession(request, session);
    return true;
  }
}
