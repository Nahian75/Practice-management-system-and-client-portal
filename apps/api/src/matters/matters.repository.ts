import { Inject, Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { clientName, visibleTo as clientVisibleTo } from '../clients/clients.repository.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, MatterTeamRole, MatterType } from '../database/schema.js';
import type { Matter, MatterSummary, NewParty, Party, TeamMember } from './matter.js';

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

  /** Inserts the matter. The database checks the conflict check and sets the number, reference and status. */
  insert(
    matter: { clientId: string; title: string; matterType: MatterType; openedBy: string; conflictCheckId: string },
    trx: Kysely<Database>,
  ) {
    return trx
      .insertInto('matters')
      .values({
        client_id: matter.clientId,
        title: matter.title,
        matter_type: matter.matterType,
        opened_by: matter.openedBy,
        conflict_check_id: matter.conflictCheckId,
      })
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
    const parties = await this.db
      .selectFrom('matter_parties')
      .innerJoin('matters', 'matters.id', 'matter_parties.matter_id')
      .select(['matter_parties.id', 'matter_parties.role', 'matter_parties.kind', 'matter_parties.name'])
      .where('matter_parties.matter_id', '=', matterId)
      .where(visibleTo(viewerId))
      .orderBy('matter_parties.added_at')
      .execute();
    return {
      ...summaryFrom(row),
      openedAt: row.opened_at,
      parties: parties.map((party): Party => ({ id: party.id, role: party.role, kind: party.kind, name: party.name })),
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

  /** Records a conflict check. The database adds the client's own name and finds the matches. */
  recordConflictCheck(check: { clientId: string; requestedBy: string; names: string[] }, trx: Kysely<Database>) {
    return trx
      .insertInto('conflict_checks')
      .values({ client_id: check.clientId, requested_by: check.requestedBy, names: check.names })
      .returning(['id', 'names', 'matches', 'match_count', 'created_at'])
      .executeTakeFirstOrThrow();
  }

  /** A check that can still open a matter: for this client, by this person, under a day old, not used. */
  async usableConflictCheck(check: { id: string; clientId: string; requestedBy: string }, trx: Kysely<Database>) {
    const row = await trx
      .selectFrom('conflict_checks')
      .select(['conflict_checks.id', 'conflict_checks.names'])
      .where('conflict_checks.id', '=', check.id)
      .where('conflict_checks.client_id', '=', check.clientId)
      .where('conflict_checks.requested_by', '=', check.requestedBy)
      .where('conflict_checks.created_at', '>', sql<Date>`clock_timestamp() - interval '24 hours'`)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('matters').select('matters.id').whereRef('matters.conflict_check_id', '=', 'conflict_checks.id'))),
      )
      .executeTakeFirst();
    return row;
  }

  /** Whether every name is among `checkedNames`, compared the way the database compares names. */
  async allNamesChecked(names: string[], checkedNames: string[], trx: Kysely<Database>): Promise<boolean> {
    if (names.length === 0) {
      return true;
    }
    const { unchecked } = await sql<{ unchecked: string }>`
      select count(*) as unchecked from unnest(${names}::text[]) as name
      where app.normalise_name(name) not in (select app.normalise_name(checked) from unnest(${checkedNames}::text[]) as checked)
    `
      .execute(trx)
      .then((result) => result.rows[0] ?? { unchecked: '0' });
    return Number(unchecked) === 0;
  }

  /** Client and matter references for the ids in a check's matches. */
  async references(clientIds: string[], matterIds: string[], executor: Kysely<Database> = this.db) {
    const clients = clientIds.length
      ? await executor.selectFrom('clients').select(['id', 'reference']).where('id', 'in', clientIds).execute()
      : [];
    const matters = matterIds.length
      ? await executor.selectFrom('matters').select(['id', 'reference']).where('id', 'in', matterIds).execute()
      : [];
    return {
      client: new Map(clients.map((row) => [row.id, row.reference])),
      matter: new Map(matters.map((row) => [row.id, row.reference])),
    };
  }

  /** The check a matter was opened on, if `viewerId` is on its team. */
  visibleConflictCheck(matterId: string, viewerId: string) {
    return this.db
      .selectFrom('matters')
      .innerJoin('conflict_checks', 'conflict_checks.id', 'matters.conflict_check_id')
      .select([
        'conflict_checks.id',
        'conflict_checks.names',
        'conflict_checks.matches',
        'conflict_checks.match_count',
        'conflict_checks.created_at',
      ])
      .where('matters.id', '=', matterId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
  }

  /** Serialises clearances of one matter, so two arriving together are answered one after the other. */
  async lockClearance(matterId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`app.conflict_clearance:${matterId}`}, 0))`.execute(trx);
  }

  /** The matter's status and reference, and whether `viewerId` is its supervising partner; if they are on its team. */
  supervisionState(matterId: string, viewerId: string, trx: Kysely<Database>) {
    return trx
      .selectFrom('matters')
      .select(['matters.status', 'matters.reference'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('matter_team')
              .select('matter_team.id')
              .whereRef('matter_team.matter_id', '=', 'matters.id')
              .where('matter_team.account_id', '=', viewerId)
              .where('matter_team.role', '=', 'supervising_partner')
              .where('matter_team.removed_at', 'is', null),
          )
          .as('is_supervisor'),
      )
      .where('matters.id', '=', matterId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
  }

  /** Serialises team changes to one matter, so two arriving together cannot both act on what they read. */
  async lockTeam(matterId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`app.matter_team:${matterId}`}, 0))`.execute(trx);
  }

  /** The person's current membership of the matter, if any. The caller has checked they may manage the team. */
  activeMembership(matterId: string, accountId: string, trx: Kysely<Database>) {
    return trx
      .selectFrom('matter_team')
      .select(['id', 'role'])
      .where('matter_id', '=', matterId)
      .where('account_id', '=', accountId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
  }

  /** Ends a membership. The database keeps it ended, and refuses to leave the matter without a supervising partner. */
  async endMembership(membershipId: string, removedBy: string, trx: Kysely<Database>): Promise<void> {
    await trx
      .updateTable('matter_team')
      .set({ removed_at: sql<Date>`clock_timestamp()`, removed_by: removedBy })
      .where('id', '=', membershipId)
      .execute();
  }

  /** The matter with this reference. Not limited by visibility: a partner taking over supervision is not on the team yet. */
  findByReference(reference: string, trx: Kysely<Database>) {
    return trx.selectFrom('matters').select(['id', 'reference']).where('reference', '=', reference).executeTakeFirst();
  }

  /** The matter's supervising partner, and whether they can still act: an active account holding the partner role. */
  async supervisor(matterId: string, trx: Kysely<Database>) {
    const row = await trx
      .selectFrom('matter_team')
      .innerJoin('accounts', 'accounts.id', 'matter_team.account_id')
      .select(['matter_team.account_id', 'accounts.status'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('account_roles')
              .select('account_roles.id')
              .whereRef('account_roles.account_id', '=', 'matter_team.account_id')
              .where('account_roles.role', '=', 'partner')
              .where('account_roles.revoked_at', 'is', null),
          )
          .as('is_partner'),
      )
      .where('matter_team.matter_id', '=', matterId)
      .where('matter_team.role', '=', 'supervising_partner')
      .where('matter_team.removed_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { accountId: row.account_id, canAct: row.status === 'active' && Boolean(row.is_partner) };
  }

  /** Records a takeover of supervision. The database checks the rules and changes the team. */
  async recordSupervisionTakeover(
    takeover: { matterId: string; fromAccountId: string; toAccountId: string; reason: string },
    trx: Kysely<Database>,
  ): Promise<string> {
    const { id } = await trx
      .insertInto('matter_supervision_takeovers')
      .values({
        matter_id: takeover.matterId,
        from_account_id: takeover.fromAccountId,
        to_account_id: takeover.toAccountId,
        reason: takeover.reason,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  /** Records the clearance. The database checks the rules and opens the matter. */
  async recordClearance(clearance: { matterId: string; clearedBy: string; reason: string }, trx: Kysely<Database>): Promise<string> {
    const { id } = await trx
      .insertInto('conflict_clearances')
      .values({ matter_id: clearance.matterId, cleared_by: clearance.clearedBy, reason: clearance.reason })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  /** The clearance of a matter, with who gave it, if `viewerId` is on its team. */
  visibleClearance(matterId: string, viewerId: string) {
    return this.db
      .selectFrom('conflict_clearances')
      .innerJoin('matters', 'matters.id', 'conflict_clearances.matter_id')
      .innerJoin('accounts', 'accounts.id', 'conflict_clearances.cleared_by')
      .select(['conflict_clearances.cleared_by', 'accounts.display_name', 'conflict_clearances.reason', 'conflict_clearances.cleared_at'])
      .where('conflict_clearances.matter_id', '=', matterId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
  }

  async addParty(party: NewParty & { matterId: string; addedBy: string }, trx: Kysely<Database>): Promise<string> {
    const { id } = await trx
      .insertInto('matter_parties')
      .values({ matter_id: party.matterId, role: party.role, kind: party.kind, name: party.name, added_by: party.addedBy })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
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
