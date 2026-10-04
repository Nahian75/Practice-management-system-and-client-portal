import { Inject, Injectable } from '@nestjs/common';
import type { AuditActor } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { StaffRole } from '../../database/schema.js';
import { RolesRepository } from './roles.repository.js';

/** Who is making a change: a signed-in staff member, or the system (command line). */
export interface RoleChangeActor {
  actor: AuditActor;
  accountId: string | null;
}

export class OwnRoleChangeError extends Error {
  override readonly name = 'OwnRoleChangeError';
}

@Injectable()
export class RolesService {
  constructor(
    private readonly roles: RolesRepository,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Grants a role to a staff account. Nobody can change their own roles,
   * otherwise an administrator could grant themselves compliance and read the
   * audit log. The database refuses roles for non-staff accounts.
   */
  async grant(accountId: string, role: StaffRole, by: RoleChangeActor): Promise<void> {
    if (by.accountId === accountId) {
      throw new OwnRoleChangeError('Nobody can change their own roles');
    }

    const granted = await this.roles.grant({ accountId, role, grantedBy: by.accountId, at: this.clock.now() });
    if (granted) {
      await this.audit.record({
        actor: by.actor,
        action: 'staff.role_granted',
        outcome: 'success',
        resource: { type: 'account', id: accountId },
        metadata: { role },
      });
    }
  }

  activeRoles(accountId: string): Promise<StaffRole[]> {
    return this.roles.activeRoles(accountId);
  }
}
