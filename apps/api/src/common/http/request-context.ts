import type { Request } from 'express';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * A dual-stack server sees an IPv4 client as `::ffff:1.2.3.4`. Recording the
 * plain IPv4 form keeps one client under one address in limits and the audit log.
 */
export function normaliseAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith(IPV4_MAPPED_PREFIX) && lower.includes('.') ? lower.slice(IPV4_MAPPED_PREFIX.length) : lower;
}

export function requestContext(request: Request): RequestContext {
  const userAgent = request.get('user-agent');
  return {
    ...(request.ip ? { ipAddress: normaliseAddress(request.ip) } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
