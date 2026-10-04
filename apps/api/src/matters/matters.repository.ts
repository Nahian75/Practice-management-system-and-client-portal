import { Inject, Injectable } from '@nestjs/common';
import type { ExpressionBuilder, Kysely } from 'kysely';
import { clientName, visibleTo as clientVisibleTo } from '../clients/clients.repository.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, MatterTeamRole, MatterType } from '../database/schema.js';
import type { Matter, MatterSummary, TeamMember } from './matter.js';

/**
 * The visibility rule for matters (docs/matters.md), in one place: an active
 * member of the matter's team. Every query that returns or changes a matter
 * filters with it. Holding the partner role alone opens nothing.
 */
export function visibleTo(viewerId: string) {
  return (eb: ExpressionBuilder<Database, 'matters'>) =>
    eb.exists(
      eb
        .selectFrom('matter_team')
        .select('matter_team.id')
        .whereRef('matter_team.matter_id', '=', 'matters.id')
        .where('matter_team.account_id', '=', viewerId)
        .where('matter_team.removed_at', 'is', null),
    );
}

@Injectable()
export class MattersRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Whether `viewerId` may see the client, under the clients module's own rule. */
  async clientIsVisible(clientId: string, viewerId: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    const row = await executor
      .selectFrom('clients')
      .select('clients.id')
      .where('clients.id', '=', clientId)
      .where(clientVisibleTo(viewerId))
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Active staff accounts among `accountIds`, with their active roles. */
  async staffWithRoles(accountIds: string[], executor: Kysely<Database> = this.db) {
    if (accountIds.length === 0) {
      return [];
    }
    const accounts = await executor
      .selectFrom('accounts')
      .select('id')
      .where('id', 'in', accountIds)
      .where('kind', '=', 'staff')
      .where('status', '=', 'active')
      .execute();
    const roles = await executor
      .selectFrom('account_roles')
      .select(['account_id', 'role'])
      .where('account_id', 'in', accountIds)
      .where('revoked_at', 'is', null)
      .execute();
    return accounts.map((account) => ({
      id: account.id,
      roles: roles.filter((row) => row.account_id === account.id).map((row) => row.role),
    }));
  }

  /** Inserts the matter. The database sets its number, reference and status. */
  insert(
    matter: { clientId: string; title: string; matterType: MatterType; openedBy: string },
    trx: Kysely<Database>,
  ) {
    return trx
      .insertInto('matters')
      .values({ client_id: matter.clientId, title: matter.title, matter_type: matter.matterType, opened_by: matter.openedBy })
      .returning(['id', 'reference', 'status'])
      .executeTakeFirstOrThrow();
  }

  async addTeamMember(
    member: { matterId: string; accountId: string; role: MatterTeamRole; addedBy: string },
    trx: Kysely<Database>,
  ): Promise<void> {
    await trx
      .insertInto('matter_team')
      .values({ matter_id: member.matterId, account_id: member.accountId, role: member.role, added_by: member.addedBy })
      .execute();
  }

  /** The matter, if `viewerId` is on its team. */
  async findVisible(matterId: string, viewerId: string): Promise<Matter | undefined> {
    const row = await this.summaries(viewerId)
      .select('matters.opened_at')
      .where('matters.id', '=', matterId)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    const team = await this.db
      .selectFrom('matter_team')
      .innerJoin('accounts', 'accounts.id', 'matter_team.account_id')
      .innerJoin('matters', 'matters.id', 'matter_team.matter_id')
      .select(['matter_team.account_id', 'accounts.display_name', 'matter_team.role'])
      .where('matter_team.matter_id', '=', matterId)
      .where('matter_team.removed_at', 'is', null)
      .where(visibleTo(viewerId))
      .orderBy('matter_team.role', 'desc')
      .orderBy('accounts.display_name')
      .execute();
    return {
      ...summaryFrom(row),
      openedAt: row.opened_at,
      team: team.map(
        (member): TeamMember => ({ accountId: member.account_id, displayName: member.display_name, role: member.role }),
      ),
    };
  }

  /** Matters `viewerId` is on the team of, newest first. `before` is the id of the last matter on the previous page. */
  async listVisible(viewerId: string, page: { before?: string; clientId?: string; limit: number }): Promise<MatterSummary[]> {
    let query = this.summaries(viewerId);
    if (page.before !== undefined) {
      query = query.where('matters.id', '<', page.before);
    }
    if (page.clientId !== undefined) {
      query = query.where('matters.client_id', '=', page.clientId);
    }
    const rows = await query.orderBy('matters.id', 'desc').limit(page.limit).execute();
    return rows.map(summaryFrom);
  }

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  private summaries(viewerId: string) {
    return this.db
      .selectFrom('matters')
      .innerJoin('clients', 'clients.id', 'matters.client_id')
      .leftJoin('client_individuals as i', 'i.client_id', 'clients.id')
      .leftJoin('client_organisations as o', 'o.client_id', 'clients.id')
      .select([
        'matters.id',
        'matters.reference',
        'matters.title',
        'matters.matter_type',
        'matters.status',
        'clients.id as client_id',
        'clients.reference as client_reference',
        'clients.kind as client_kind',
        clientName.as('client_name'),
      ])
      .where(visibleTo(viewerId));
  }
}

function summaryFrom(row: {
  id: string;
  reference: string;
  title: string;
  matter_type: MatterType;
  status: MatterSummary['status'];
  client_id: string;
  client_reference: string;
  client_kind: MatterSummary['client']['kind'];
  client_name: string;
}): MatterSummary {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    matterType: row.matter_type,
    status: row.status,
    client: { id: row.client_id, reference: row.client_reference, kind: row.client_kind, name: row.client_name },
  };
}
