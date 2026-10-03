import type { Request } from 'express';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export function requestContext(request: Request): RequestContext {
  const userAgent = request.get('user-agent');
  return {
    ...(request.ip ? { ipAddress: request.ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
