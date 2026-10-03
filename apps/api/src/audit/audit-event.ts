import type { AuditMetadataValue } from '../database/schema.js';

export type AuditActor =
  | { type: 'user'; id: string }
  | { type: 'client'; id: string }
  | { type: 'system' }
  | { type: 'anonymous' };

export interface AuditEvent {
  actor: AuditActor;
  /** `domain.verb`, lower case, e.g. `auth.sign_in_failed`. */
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  resource?: { type: string; id: string };
  ipAddress?: string;
  userAgent?: string;
  /** IDs and outcomes only. Never passwords, tokens or document contents. */
  metadata?: Record<string, AuditMetadataValue>;
}
