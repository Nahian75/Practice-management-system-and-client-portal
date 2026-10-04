import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { permissionsFor } from '../auth/permissions/permissions.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { MatterStatus, MatterTeamRole } from '../database/schema.js';
import type { Matter, MatterSummary, NewMatter } from './matter.js';
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
  | { outcome: 'client_not_found' | 'invalid_supervisor' | 'invalid_team_member' };

@Injectable()
export class MattersService {
  constructor(
    private readonly matters: MattersRepository,
    private readonly audit: AuditService,
  ) {}

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
        { clientId: input.clientId, title: input.title, matterType: input.matterType, openedBy: by.accountId },
        trx,
      );
      await this.audit.record(
        {
          actor: by.actor,
          action: 'matter.opened',
          outcome: 'success',
          resource: { type: 'matter', id: matter.id },
          metadata: { clientId: input.clientId, matterType: input.matterType, status: matter.status },
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
      return { outcome: 'opened', ...matter };
    });
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
