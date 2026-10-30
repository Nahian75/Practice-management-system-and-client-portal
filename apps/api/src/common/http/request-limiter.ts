import { createHash } from 'node:crypto';
import { HttpException, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../database/schema.js';
import { sessionOf } from '../../auth/sessions/authenticated-session.js';
import { normaliseAddress } from './request-context.js';

export class RequestLimiter {
  constructor(private readonly db: Kysely<Database>) {}

  async consume(scope: 'general' | 'authentication' | 'recovery' | 'account', subject: string) {
    const key = createHash('sha256').update(`stass-api-limit:${scope}:${subject}`).digest();
    const { rows } = await sql<{ allowed: boolean; retry_after: number }>`
      SELECT * FROM app.consume_api_request_limit(${scope},${key})`.execute(this.db);
    return rows[0]!;
  }

  middleware = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    // Liveness/readiness are probed by the platform and expose no record data.
    if (request.method === 'GET' && ['/health','/ready'].includes(request.path)) { next(); return; }
    const address = normaliseAddress(request.ip || request.socket.remoteAddress || 'unknown');
    // IPv6 neighbours share the same /64, as in the sign-in limiter.
    const subject = address.includes(':') ? ipv6Network(address) : address;
    const scopes: ('general'|'authentication'|'recovery')[] = ['general'];
    if (request.path.startsWith('/auth/')) scopes.push('authentication');
    if (request.path.startsWith('/auth/password-reset/') || request.path.startsWith('/auth/invitations/')) scopes.push('recovery');
    try {
      for (const scope of scopes) {
        const result = await this.consume(scope, subject);
        if (!result.allowed) {
          response.setHeader('Retry-After', String(result.retry_after));
          response.status(429).json({ statusCode: 429, message: 'Too many requests. Try again later.' });
          return;
        }
      }
      next();
    } catch {
      // Limiter/database failure cannot silently disable the abuse boundary.
      response.status(503).json({ statusCode: 503, message: 'Service temporarily unavailable' });
    }
  };
}

function ipv6Network(address: string): string {
  // URL normalization expands neither addresses nor zero groups, so explicitly
  // expand the :: once before keeping the first four 16-bit groups.
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right];
  return groups.slice(0,4).map(value => parseInt(value,16).toString(16)).join(':')+'::/64';
}

export class AccountRateGuard implements CanActivate {
  constructor(private readonly limiter: RequestLimiter) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const session = sessionOf(request);
    if (!session) return true;
    let result;
    try { result = await this.limiter.consume('account',session.account.id); }
    catch { throw new ServiceUnavailableException('Service temporarily unavailable'); }
    if (!result.allowed) {
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After',String(result.retry_after));
      throw new HttpException('Too many requests. Try again later.',429);
    }
    return true;
  }
}
