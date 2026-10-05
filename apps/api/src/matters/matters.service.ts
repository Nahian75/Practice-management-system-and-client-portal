import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SecurityNoticesService } from '../auth/notices/security-notices.service.js';
import { permissionsFor } from '../auth/permissions/permissions.js';
import { SearchQuota } from '../clients/search-quota.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { ConflictMatchRow, Database, MatterStatus, MatterTeamRole } from '../database/schema.js';
import type { ConflictCheck, Matter, MatterSummary, NewMatter } from './matter.js';
import { MattersRepository } from './matters.repository.js';

export const MATTERS_PAGE_SIZE = 50;

/** The signed-in staff member acting, and the request it came from. */
export interface MatterActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type OpenResult =
  | { outcome: 'opened'; id: string; reference: string; status: MatterStatus }
  | { outcome: 'client_not_found' | 'invalid_supervisor' | 'invalid_team_member' | 'invalid_conflict_check' | 'party_not_checked' };

export type ClearanceResult = 'cleared' | 'not_found' | 'not_supervisor' | 'not_awaiting_clearance';

export type SupervisionTakeoverResult = 'taken_over' | 'not_found' | 'supervisor_can_act';

export type TeamChangeResult = 'changed' | 'unchanged' | 'not_found' | 'not_supervisor' | 'invalid_member' | 'is_supervisor';

export type ConflictCheckResult = { outcome: 'checked'; check: ConflictCheck } | { outcome: 'client_not_found' | 'limited' };

@Injectable()
export class MattersService {
  constructor(
    private readonly matters: MattersRepository,
    private readonly audit: AuditService,
    private readonly quota: SearchQuota,
    private readonly notices: SecurityNoticesService,
  ) {}

  /**
   * Runs a conflict check for a client the caller can see. The database adds
   * the client's own name and finds the possible matches. Counts towards the
   * same hourly allowance as client search, and the names stay out of the
   * audit log: they are kept with the check.
   */
  runConflictCheck(clientId: string, names: string[], by: MatterActor): Promise<ConflictCheckResult> {
    return this.matters.transaction(async (trx): Promise<ConflictCheckResult> => {
      if (!(await this.matters.clientIsVisible(clientId, by.accountId, trx))) {
        return { outcome: 'client_not_found' };
      }
      if (!(await this.quota.allows(by, trx))) {
        return { outcome: 'limited' };
      }

      const check = await this.matters.recordConflictCheck({ clientId, requestedBy: by.accountId, names }, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'matter.conflict_check_run',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { checkId: check.id, names: check.names.length, matches: check.match_count },
          ...by.context,
        },
        trx,
      );
      return { outcome: 'checked', check: { ...(await this.describe(check, trx)), clearance: null } };
    });
  }

  /** The check a matter was opened on, for its team. */
  async conflictCheckOf(matterId: string, viewerId: string): Promise<ConflictCheck | undefined> {
    const check = await this.matters.visibleConflictCheck(matterId, viewerId);
    if (!check) {
      return undefined;
    }
    const clearance = await this.matters.visibleClearance(matterId, viewerId);
    return {
      ...(await this.describe(check)),
      clearance: clearance
        ? {
            clearedBy: { accountId: clearance.cleared_by, displayName: clearance.display_name },
            reason: clearance.reason,
            clearedAt: clearance.cleared_at,
          }
        : null,
    };
  }

  /**
   * The supervising partner records why a possible conflict is not one, which
   * opens the matter. The reason is kept with the clearance; the audit log
   * points to it. Compliance holders are told once the change has committed.
   */
  async clearConflict(matterId: string, reason: string, by: MatterActor): Promise<ClearanceResult> {
    const outcome = await this.matters.transaction(async (trx): Promise<{ result: ClearanceResult; reference?: string }> => {
      await this.matters.lockClearance(matterId, trx);
      const state = await this.matters.supervisionState(matterId, by.accountId, trx);
      if (!state) {
        return { result: 'not_found' };
      }
      if (!state.is_supervisor) {
        return { result: 'not_supervisor' };
      }
      if (state.status !== 'awaiting_clearance') {
        return { result: 'not_awaiting_clearance' };
      }

      const clearanceId = await this.matters.recordClearance({ matterId, clearedBy: by.accountId, reason }, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'matter.conflict_cleared',
          outcome: 'success',
          resource: { type: 'matter', id: matterId },
          metadata: { clearanceId },
          ...by.context,
        },
        trx,
      );
      return { result: 'cleared', reference: state.reference };
    });

    if (outcome.reference) {
      await this.notices.conflictCleared({ matterReference: outcome.reference, clearedBy: by.accountId });
    }
    return outcome.result;
  }

  /** Replaces the ids in a check's matches with references, which is all a reader needs. */
  private async describe(
    check: { id: string; names: string[]; matches: ConflictMatchRow[]; match_count: number; created_at: Date },
    executor?: Kysely<Database>,
  ): Promise<Omit<ConflictCheck, 'clearance'>> {
    const references = await this.matters.references(
      [...new Set(check.matches.map((match) => match.clientId))],
      [...new Set(check.matches.flatMap((match) => (match.matterId ? [match.matterId] : [])))],
      executor,
    );
    return {
      id: check.id,
      names: check.names,
      matchCount: check.match_count,
      createdAt: check.created_at,
      matches: check.matches.map((match) => ({
        checkedName: match.checkedName,
        matchedName: match.matchedName,
        relation: match.relation,
        clientReference: references.client.get(match.clientId) ?? '',
        matterReference: match.matterId ? (references.matter.get(match.matterId) ?? null) : null,
      })),
    };
  }

  /**
   * Opens a matter for a client the caller can see. The caller is always on
   * the team: as supervising partner if they named themselves, otherwise as a
   * fee earner. Each member is recorded in the audit log, since joining a
   * team is what gives access to the matter and its client.
   */
  open(input: NewMatter, by: MatterActor): Promise<OpenResult> {
    return this.matters.transaction(async (trx): Promise<OpenResult> => {
      if (!(await this.matters.clientIsVisible(input.clientId, by.accountId, trx))) {
        return { outcome: 'client_not_found' };
      }
      const check = await this.matters.usableConflictCheck(
        { id: input.conflictCheckId, clientId: input.clientId, requestedBy: by.accountId },
        trx,
      );
      if (!check) {
        return { outcome: 'invalid_conflict_check' };
      }
      if (!(await this.matters.allNamesChecked(input.parties.map((party) => party.name), check.names, trx))) {
        return { outcome: 'party_not_checked' };
      }

      const team = new Map<string, MatterTeamRole>([[input.supervisingPartnerId, 'supervising_partner']]);
      for (const accountId of [...input.feeEarnerIds, by.accountId]) {
        if (!team.has(accountId)) {
          team.set(accountId, 'fee_earner');
        }
      }

      const staff = new Map(
        (await this.matters.staffWithRoles([...team.keys()], trx)).map((account) => [account.id, account.roles]),
      );
      if (!staff.get(input.supervisingPartnerId)?.includes('partner')) {
        return { outcome: 'invalid_supervisor' };
      }
      for (const accountId of team.keys()) {
        if (!permissionsFor(staff.get(accountId) ?? []).has('matters.view')) {
          return { outcome: 'invalid_team_member' };
        }
      }

      const matter = await this.matters.insert(
        {
          clientId: input.clientId,
          title: input.title,
          matterType: input.matterType,
          openedBy: by.accountId,
          conflictCheckId: check.id,
        },
        trx,
      );
      await this.audit.record(
        {
          actor: by.actor,
          action: 'matter.opened',
          outcome: 'success',
          resource: { type: 'matter', id: matter.id },
          metadata: { clientId: input.clientId, matterType: input.matterType, status: matter.status, conflictCheckId: check.id },
          ...by.context,
        },
        trx,
      );
      for (const [accountId, role] of team) {
        await this.matters.addTeamMember({ matterId: matter.id, accountId, role, addedBy: by.accountId }, trx);
        await this.audit.record(
          {
            actor: by.actor,
            action: 'matter.team_member_added',
            outcome: 'success',
            resource: { type: 'matter', id: matter.id },
            metadata: { accountId, role },
            ...by.context,
          },
          trx,
        );
      }
      for (const party of input.parties) {
        const partyId = await this.matters.addParty({ ...party, matterId: matter.id, addedBy: by.accountId }, trx);
        await this.audit.record(
          {
            actor: by.actor,
            action: 'matter.party_added',
            outcome: 'success',
            resource: { type: 'matter', id: matter.id },
            metadata: { partyId, role: party.role },
            ...by.context,
          },
          trx,
        );
      }
      return { outcome: 'opened', ...matter };
    });
  }

  /** Adds a fee earner to the team. Joining gives access to the matter and its client, so it is recorded. */
  addFeeEarner(matterId: string, accountId: string, by: MatterActor): Promise<TeamChangeResult> {
    return this.matters.transaction(async (trx): Promise<TeamChangeResult> => {
      const refusal = await this.refuseUnlessSupervisor(matterId, by, trx);
      if (refusal) {
        return refusal;
      }
      if (await this.matters.activeMembership(matterId, accountId, trx)) {
        return 'unchanged';
      }
      const [candidate] = await this.matters.staffWithRoles([accountId], trx);
      if (!candidate || !permissionsFor(candidate.roles).has('matters.view')) {
        return 'invalid_member';
      }

      await this.matters.addTeamMember({ matterId, accountId, role: 'fee_earner', addedBy: by.accountId }, trx);
      await this.recordTeamEvent('matter.team_member_added', matterId, { accountId, role: 'fee_earner' }, by, trx);
      return 'changed';
    });
  }

  /** Removes a fee earner, who loses access at once. The supervising partner leaves only by handing over. */
  removeFeeEarner(matterId: string, accountId: string, by: MatterActor): Promise<TeamChangeResult> {
    return this.matters.transaction(async (trx): Promise<TeamChangeResult> => {
      const refusal = await this.refuseUnlessSupervisor(matterId, by, trx);
      if (refusal) {
        return refusal;
      }
      const membership = await this.matters.activeMembership(matterId, accountId, trx);
      if (!membership) {
        return 'unchanged';
      }
      if (membership.role === 'supervising_partner') {
        return 'is_supervisor';
      }

      await this.matters.endMembership(membership.id, by.accountId, trx);
      await this.recordTeamEvent('matter.team_member_removed', matterId, { accountId, role: membership.role }, by, trx);
      return 'changed';
    });
  }

  /**
   * Hands supervision to another partner. The previous supervising partner
   * stays on the team as a fee earner, so nobody loses access as a side
   * effect; the new supervising partner can remove them.
   */
  handOverSupervision(matterId: string, partnerId: string, by: MatterActor): Promise<TeamChangeResult> {
    return this.matters.transaction(async (trx): Promise<TeamChangeResult> => {
      const refusal = await this.refuseUnlessSupervisor(matterId, by, trx);
      if (refusal) {
        return refusal;
      }
      if (partnerId === by.accountId) {
        return 'unchanged';
      }
      const [candidate] = await this.matters.staffWithRoles([partnerId], trx);
      if (!candidate?.roles.includes('partner')) {
        return 'invalid_member';
      }

      const current = await this.matters.activeMembership(matterId, by.accountId, trx);
      const incoming = await this.matters.activeMembership(matterId, partnerId, trx);
      if (!current) {
        throw new Error('Supervising partner has no membership');
      }
      await this.matters.endMembership(current.id, by.accountId, trx);
      if (incoming) {
        await this.matters.endMembership(incoming.id, by.accountId, trx);
      }
      await this.matters.addTeamMember({ matterId, accountId: partnerId, role: 'supervising_partner', addedBy: by.accountId }, trx);
      await this.matters.addTeamMember({ matterId, accountId: by.accountId, role: 'fee_earner', addedBy: by.accountId }, trx);
      await this.recordTeamEvent('matter.supervisor_changed', matterId, { from: by.accountId, to: partnerId }, by, trx);
      return 'changed';
    });
  }

  /**
   * Makes the caller supervising partner of a matter whose supervising
   * partner can no longer act (account not active, or no partner role). The
   * caller is usually not on the team, so the matter is named by reference.
   * The reason is kept with the takeover; the audit log points to it.
   */
  async takeOverSupervision(matterReference: string, reason: string, by: MatterActor): Promise<SupervisionTakeoverResult> {
    const outcome = await this.matters.transaction(
      async (trx): Promise<{ result: SupervisionTakeoverResult; matterId?: string; from?: string }> => {
        const matter = await this.matters.findByReference(matterReference, trx);
        if (!matter) {
          return { result: 'not_found' };
        }
        await this.matters.lockTeam(matter.id, trx);
        const supervisor = await this.matters.supervisor(matter.id, trx);
        if (supervisor.canAct) {
          return { result: 'supervisor_can_act', matterId: matter.id };
        }

        const takeoverId = await this.matters.recordSupervisionTakeover(
          { matterId: matter.id, fromAccountId: supervisor.accountId, toAccountId: by.accountId, reason },
          trx,
        );
        await this.recordTeamEvent(
          'matter.supervision_taken_over',
          matter.id,
          { takeoverId, from: supervisor.accountId },
          by,
          trx,
        );
        return { result: 'taken_over', matterId: matter.id, from: supervisor.accountId };
      },
    );

    if (outcome.result === 'taken_over' && outcome.from) {
      await this.notices.supervisionTakenOver({ matterReference, fromAccountId: outcome.from, toAccountId: by.accountId });
    }
    // Trying to take a matter from a partner who can still act is worth noticing.
    if (outcome.result === 'supervisor_can_act' && outcome.matterId) {
      await this.audit.record({
        actor: by.actor,
        action: 'matter.supervision_takeover_refused',
        outcome: 'denied',
        resource: { type: 'matter', id: outcome.matterId },
        metadata: { reason: 'supervisor_can_act' },
        ...by.context,
      });
    }
    return outcome.result;
  }

  /** Under the team lock: the caller must be on the team (else not found) and its supervising partner. */
  private async refuseUnlessSupervisor(matterId: string, by: MatterActor, trx: Kysely<Database>): Promise<TeamChangeResult | null> {
    await this.matters.lockTeam(matterId, trx);
    const state = await this.matters.supervisionState(matterId, by.accountId, trx);
    if (!state) {
      return 'not_found';
    }
    return state.is_supervisor ? null : 'not_supervisor';
  }

  private async recordTeamEvent(
    action:
      | 'matter.team_member_added'
      | 'matter.team_member_removed'
      | 'matter.supervisor_changed'
      | 'matter.supervision_taken_over',
    matterId: string,
    metadata: Record<string, string>,
    by: MatterActor,
    trx: Kysely<Database>,
  ): Promise<void> {
    await this.audit.record(
      { actor: by.actor, action, outcome: 'success', resource: { type: 'matter', id: matterId }, metadata, ...by.context },
      trx,
    );
  }

  find(matterId: string, viewerId: string): Promise<Matter | undefined> {
    return this.matters.findVisible(matterId, viewerId);
  }

  /** One page of the matters `viewerId` is on; `next` is passed back as `before`. */
  async list(viewerId: string, before?: string): Promise<{ matters: MatterSummary[]; next: string | null }> {
    const matters = await this.matters.listVisible(viewerId, { before, limit: MATTERS_PAGE_SIZE });
    return { matters, next: matters.length === MATTERS_PAGE_SIZE ? (matters.at(-1)?.id ?? null) : null };
  }

  /** The client's matters that `viewerId` is on, if they can see the client at all. */
  async listForClient(clientId: string, viewerId: string): Promise<MatterSummary[] | undefined> {
    if (!(await this.matters.clientIsVisible(clientId, viewerId))) {
      return undefined;
    }
    return this.matters.listVisible(viewerId, { clientId, limit: 200 });
  }
}
