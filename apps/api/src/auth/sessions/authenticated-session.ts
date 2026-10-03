import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditActor } from '../../audit/audit-event.js';
import type { AccountKind, SessionStage } from '../../database/schema.js';

export interface SessionAccount {
  id: string;
  kind: AccountKind;
  displayName: string;
}

export interface ResolvedSession {
  sessionId: string;
  stage: SessionStage;
  account: SessionAccount;
}

export function auditActorFor(account: SessionAccount): AuditActor {
  return account.kind === 'staff' ? { type: 'user', id: account.id } : { type: 'client', id: account.id };
}

// Keyed by the request object itself, so nothing is added to the Express
// Request type and nothing outlives the request.
const sessionsByRequest = new WeakMap<Request, ResolvedSession>();

export function attachSession(request: Request, session: ResolvedSession): void {
  sessionsByRequest.set(request, session);
}

export class NoSessionOnRequestError extends Error {
  override readonly name = 'NoSessionOnRequestError';
}

/** The signed-in session. Only usable on routes the SessionGuard has checked. */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const session = sessionsByRequest.get(context.switchToHttp().getRequest<Request>());
  if (!session) {
    throw new NoSessionOnRequestError('@CurrentSession() used on a route without a checked session');
  }
  return session;
});
