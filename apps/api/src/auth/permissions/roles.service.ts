import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../../audit/audit-event.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestContext } from '../../common/http/request-context.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { Database, StaffRole } from '../../database/schema.js';
import { SecurityNoticesService } from '../notices/security-notices.service.js';
import { PROTECTED_ROLES, type ProtectedRole } from './permissions.js';
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

/** Why removing a protected role or the appointed nominated officer was refused. */
export type LastHolderRefusal = `last_${ProtectedRole}` | 'last_nominated_officer';

export function isLastHolderRefusal(result: string): result is LastHolderRefusal {
  return result === 'last_nominated_officer' || PROTECTED_ROLES.some((role) => result === `last_${role}`);
}

export type RevokeResult = 'revoked' | 'not_held' | LastHolderRefusal;

@Injectable()
export class RolesService {
  constructor(
    private readonly roles: RolesRepository,
    private readonly audit: AuditService,
    private readonly notices: SecurityNoticesService,
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

    const granted = await this.roles.transaction(async (trx) => {
      if (!(await this.roles.grant({ accountId, role, grantedBy: by.accountId, at: this.clock.now() }, trx))) {
        return false;
      }
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
      return true;
    });
    if (granted) {
      await this.notices.roleGranted(accountId, role, by.accountId);
    }
  }

  /** Revokes a role. Refuses to remove the last active holder of a protected role. */
  async revoke(accountId: string, role: StaffRole, by: RoleChangeActor): Promise<RevokeResult> {
    if (by.accountId === accountId) {
      throw new OwnRoleChangeError('Nobody can change their own roles');
    }

    const result = await this.roles.transaction(async (trx): Promise<RevokeResult> => {
      await this.roles.lockProtectedRoleChanges(trx);
      if (!(await this.roles.activeRoles(accountId, trx)).includes(role)) {
        return 'not_held';
      }
      const refusal = await this.lastHolderRefusal(accountId, [role], trx);
      if (refusal) {
        return refusal;
      }
      await this.roles.revoke({ accountId, role, revokedBy: by.accountId, at: this.clock.now() }, trx);
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
    if (result === 'revoked') {
      await this.notices.roleRevoked(accountId, role, by.accountId);
    }
    return result;
  }

  /**
   * Whether taking `roles` away from the account would leave a protected role
   * with no active holder. Call it inside a transaction that holds
   * `lockProtectedRoleChanges`, so the answer cannot change before it commits.
   */
  async lastHolderRefusal(
    accountId: string,
    roles: readonly StaffRole[],
    trx: Kysely<Database>,
  ): Promise<LastHolderRefusal | null> {
    if (roles.includes('compliance')
      && await this.roles.hasActiveNominatedAppointment(accountId, trx)
      && await this.roles.countOtherActiveNominatedOfficers(accountId, trx) === 0) {
      return 'last_nominated_officer';
    }
    for (const role of PROTECTED_ROLES) {
      if (roles.includes(role) && (await this.roles.countOtherActiveHolders(role, accountId, trx)) === 0) {
        return `last_${role}`;
      }
    }
    return null;
  }

  activeRoles(accountId: string): Promise<StaffRole[]> {
    return this.roles.activeRoles(accountId);
  }
}
