import { Inject, Injectable } from '@nestjs/common';
import type { AuditActor } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { StaffRole } from '../../database/schema.js';
import { RolesRepository } from './roles.repository.js';

/** Who is making a change: a signed-in staff member, or the system (command line). */
export interface RoleChangeActor {
  actor: AuditActor;
  accountId: string | null;
  /** The request the change came from, for the audit log. Absent for the command line. */
  context?: RequestContext;
}

export class OwnRoleChangeError extends Error {
  override readonly name = 'OwnRoleChangeError';
}

export type RevokeResult = 'revoked' | 'not_held' | 'last_administrator';

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

    await this.roles.transaction(async (trx) => {
      const granted = await this.roles.grant({ accountId, role, grantedBy: by.accountId, at: this.clock.now() }, trx);
      if (granted) {
        await this.audit.record(
          {
            actor: by.actor,
            action: 'staff.role_granted',
            outcome: 'success',
            resource: { type: 'account', id: accountId },
            metadata: { role },
            ...by.context,
          },
          trx,
        );
      }
    });
  }

  /** Revokes a role. Refuses to remove the last active administrator. */
  async revoke(accountId: string, role: StaffRole, by: RoleChangeActor): Promise<RevokeResult> {
    if (by.accountId === accountId) {
      throw new OwnRoleChangeError('Nobody can change their own roles');
    }

    return this.roles.transaction(async (trx): Promise<RevokeResult> => {
      await this.roles.lockAdministratorChanges(trx);
      if (role === 'administrator' && (await this.roles.countOtherActiveAdministrators(accountId, trx)) === 0) {
        return 'last_administrator';
      }
      const revoked = await this.roles.revoke({ accountId, role, revokedBy: by.accountId, at: this.clock.now() }, trx);
      if (!revoked) {
        return 'not_held';
      }
      await this.audit.record(
        {
          actor: by.actor,
          action: 'staff.role_revoked',
          outcome: 'success',
          resource: { type: 'account', id: accountId },
          metadata: { role },
          ...by.context,
        },
        trx,
      );
      return 'revoked';
    });
  }

  activeRoles(accountId: string): Promise<StaffRole[]> {
    return this.roles.activeRoles(accountId);
  }
}
