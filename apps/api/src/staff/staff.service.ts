import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { InvitationsRepository } from '../auth/invitations/invitations.repository.js';
import { AccountNotInvitableError, InvitationsService } from '../auth/invitations/invitations.service.js';
import { RolesRepository } from '../auth/permissions/roles.repository.js';
import {
  isLastHolderRefusal,
  RolesService,
  type LastHolderRefusal,
  type RevokeResult,
  type RoleChangeActor,
} from '../auth/permissions/roles.service.js';
import { SessionsService } from '../auth/sessions/sessions.service.js';
import { CLOCK, type Clock } from '../common/time/clock.js';
import type { StaffRole } from '../database/schema.js';
import { StaffRepository, type StaffMember } from './staff.repository.js';

/** The signed-in staff member making a change, and the request it came from. */
export interface StaffActor extends RoleChangeActor {
  accountId: string;
}

export type InviteResult =
  | { outcome: 'invited'; accountId: string; expiresAt: Date }
  | { outcome: 'not_invitable' };

export type GrantResult = 'granted' | 'not_found' | 'own_account' | 'disabled';
export type RevokeRoleResult = RevokeResult | 'not_found' | 'own_account';
export type DisableResult = 'disabled' | 'already_disabled' | 'not_found' | 'own_account' | LastHolderRefusal;
export type EnableResult =
  | { outcome: 'enabled'; expiresAt: Date }
  | { outcome: 'not_found' | 'own_account' | 'not_disabled' };

/**
 * Managing staff accounts. The rules that keep the firm from locking itself
 * out live here: nobody changes their own roles or disables themselves, and
 * the last active administrator or compliance holder cannot be removed.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly staff: StaffRepository,
    private readonly roles: RolesService,
    private readonly rolesRepository: RolesRepository,
    private readonly invitations: InvitationsService,
    private readonly invitationsRepository: InvitationsRepository,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(): Promise<StaffMember[]> {
    return this.staff.list();
  }

  /** Inviting someone already invited sends a fresh link and cancels the old one. */
  async invite(input: { email: string; displayName: string }, by: StaffActor): Promise<InviteResult> {
    try {
      const invitation = await this.invitations.invite({ kind: 'staff', ...input }, by);
      return { outcome: 'invited', ...invitation };
    } catch (error) {
      if (error instanceof AccountNotInvitableError) {
        return { outcome: 'not_invitable' };
      }
      throw error;
    }
  }

  async grantRole(accountId: string, role: StaffRole, by: StaffActor): Promise<GrantResult> {
    const account = await this.staff.findStaff(accountId);
    if (!account) {
      return 'not_found';
    }
    if (account.id === by.accountId) {
      await this.recordRefusal(by, account.id, { change: 'grant_role', role, reason: 'own_account' });
      return 'own_account';
    }
    if (account.status === 'disabled') {
      return 'disabled';
    }
    await this.roles.grant(account.id, role, by);
    return 'granted';
  }

  async revokeRole(accountId: string, role: StaffRole, by: StaffActor): Promise<RevokeRoleResult> {
    const account = await this.staff.findStaff(accountId);
    if (!account) {
      return 'not_found';
    }
    if (account.id === by.accountId) {
      await this.recordRefusal(by, account.id, { change: 'revoke_role', role, reason: 'own_account' });
      return 'own_account';
    }
    const result = await this.roles.revoke(account.id, role, by);
    if (isLastHolderRefusal(result)) {
      await this.recordRefusal(by, account.id, { change: 'revoke_role', role, reason: result });
    }
    return result;
  }

  /**
   * Disables a staff account and ends its sessions. Its roles are kept, so the
   * record shows what the person could do while the account was in use.
   */
  async disable(accountId: string, by: StaffActor): Promise<DisableResult> {
    const account = await this.staff.findStaff(accountId);
    if (!account) {
      return 'not_found';
    }
    if (account.id === by.accountId) {
      await this.recordRefusal(by, account.id, { change: 'disable', reason: 'own_account' });
      return 'own_account';
    }

    const result = await this.rolesRepository.transaction(async (trx): Promise<DisableResult> => {
      await this.rolesRepository.lockProtectedRoleChanges(trx);
      const heldRoles = await this.rolesRepository.activeRoles(account.id, trx);
      const refusal = await this.roles.lastHolderRefusal(account.id, heldRoles, trx);
      if (refusal) {
        return refusal;
      }
      if (!(await this.staff.disable(account.id, trx))) {
        return 'already_disabled';
      }
      const sessionsEnded = await this.sessions.endAllForAccount(account.id, 'revoked', trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'staff.disabled',
          outcome: 'success',
          resource: { type: 'account', id: account.id },
          metadata: { sessionsEnded },
          ...by.context,
        },
        trx,
      );
      return 'disabled';
    });

    if (isLastHolderRefusal(result)) {
      await this.recordRefusal(by, account.id, { change: 'disable', reason: result });
    }
    return result;
  }

  /**
   * Re-enables a disabled staff account. The old password is removed and a new
   * invitation is emailed, so getting back in takes the email inbox, a new
   * password and the authenticator app. Earlier sessions stay ended, and the
   * kept roles apply again once the invitation is accepted.
   */
  async enable(accountId: string, by: StaffActor): Promise<EnableResult> {
    const account = await this.staff.findStaff(accountId);
    if (!account) {
      return { outcome: 'not_found' };
    }
    if (account.id === by.accountId) {
      await this.recordRefusal(by, account.id, { change: 'enable', reason: 'own_account' });
      return { outcome: 'own_account' };
    }

    // An invitation left open when the account was disabled would work again
    // once the account is invited, so it is closed in the same transaction.
    const reopened = await this.rolesRepository.transaction(async (trx) => {
      if (!(await this.staff.reopen(account.id, trx))) {
        return false;
      }
      await this.invitationsRepository.closeOpenForAccount(account.id, this.clock.now(), trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'staff.enabled',
          outcome: 'success',
          resource: { type: 'account', id: account.id },
          ...by.context,
        },
        trx,
      );
      return true;
    });
    if (!reopened) {
      return { outcome: 'not_disabled' };
    }

    const { expiresAt } = await this.invitations.invite(
      { kind: 'staff', email: account.email, displayName: account.display_name },
      by,
    );
    return { outcome: 'enabled', expiresAt };
  }

  /** Refusals are recorded too: an attempt to change one's own roles is worth noticing. */
  private async recordRefusal(
    by: StaffActor,
    accountId: string,
    metadata: {
      change: 'grant_role' | 'revoke_role' | 'disable' | 'enable';
      role?: StaffRole;
      reason: 'own_account' | LastHolderRefusal;
    },
  ): Promise<void> {
    await this.audit.record({
      actor: by.actor,
      action: 'staff.change_refused',
      outcome: 'denied',
      resource: { type: 'account', id: accountId },
      metadata,
      ...by.context,
    });
  }
}
