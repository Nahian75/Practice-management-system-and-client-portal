import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditService } from '../../audit/audit.service.js';
import { requestContext } from '../../common/http/request-context.js';
import { auditActorFor, sessionOf } from '../sessions/authenticated-session.js';
import type { Permission } from './permissions.js';
import { PermissionsService } from './permissions.service.js';
import { PERMISSION_KEY } from './require-permission.decorator.js';

export class PermissionWithoutSessionError extends Error {
  override readonly name = 'PermissionWithoutSessionError';
}

/** Runs after the SessionGuard. Enforces @RequirePermission(...). */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const session = sessionOf(request);
    if (!session) {
      // @RequirePermission implies @StaffOnly, so the SessionGuard has always run first.
      throw new PermissionWithoutSessionError(`${permission} required on a route with no checked session`);
    }

    if (session.account.kind === 'staff' && (await this.permissions.has(session.account.id, permission))) {
      return true;
    }

    await this.audit.record({
      actor: auditActorFor(session.account),
      action: 'auth.permission_denied',
      outcome: 'denied',
      metadata: { permission, method: request.method, path: request.path },
      ...requestContext(request),
    });
    throw new ForbiddenException();
  }
}
