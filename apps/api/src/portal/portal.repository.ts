import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { visibleTo as clientVisibleTo } from '../clients/clients.repository.js';
import { DATABASE } from '../database/database.module.js';
import type { AccountKind, AccountStatus, ClientKind, Database } from '../database/schema.js';

/** The person on a client's record a login would be for, as the firm holds them. */
export interface PersonOnRecord {
  clientKind: ClientKind;
  contactId: string | null;
  displayName: string;
  email: string | null;
}

export interface PortalPerson {
  id: string;
  accountId: string;
  contactId: string | null;
  name: string;
  email: string;
  accountStatus: AccountStatus;
  linkedAt: Date;
}

@Injectable()
export class PortalRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  /** The client's kind, if `viewerId` may see the client, under the clients module's own rule. */
  async visibleClientKind(clientId: string, viewerId: string): Promise<ClientKind | undefined> {
    const row = await this.db.selectFrom('clients').select('clients.kind').where('clients.id', '=', clientId).where(clientVisibleTo(viewerId)).executeTakeFirst();
    return row?.kind;
  }

  /** The individual client themself, from their record. */
  async individual(clientId: string): Promise<PersonOnRecord | undefined> {
    const row = await this.db
      .selectFrom('client_individuals')
      .select(['given_names', 'family_name', 'email'])
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    return row && { clientKind: 'individual', contactId: null, displayName: `${row.given_names} ${row.family_name}`, email: row.email };
  }

  /** One active contact of the client, from their record. */
  async activeContact(clientId: string, contactId: string): Promise<PersonOnRecord | undefined> {
    const row = await this.db
      .selectFrom('client_contacts')
      .select(['id', 'given_names', 'family_name', 'email'])
      .where('client_id', '=', clientId)
      .where('id', '=', contactId)
      .where('active', '=', true)
      .executeTakeFirst();
    return row && { clientKind: 'organisation', contactId: row.id, displayName: `${row.given_names} ${row.family_name}`, email: row.email };
  }

  accountByEmail(email: string): Promise<{ id: string; kind: AccountKind; status: AccountStatus } | undefined> {
    return this.db.selectFrom('accounts').select(['id', 'kind', 'status']).where('email', '=', email).executeTakeFirst();
  }

  async hasActiveLink(accountId: string, clientId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('portal_links')
      .select('id')
      .where('account_id', '=', accountId)
      .where('client_id', '=', clientId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Records a link. The database checks the account, the person and that the address is the one on record. */
  async link(link: { accountId: string; clientId: string; contactId: string | null; linkedBy: string }, trx: Kysely<Database>) {
    return trx
      .insertInto('portal_links')
      .values({ account_id: link.accountId, client_id: link.clientId, contact_id: link.contactId, linked_by: link.linkedBy })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  /** The people who may see the client in the portal now, by name. */
  async activeLinks(clientId: string): Promise<PortalPerson[]> {
    const rows = await this.db
      .selectFrom('portal_links')
      .innerJoin('accounts', 'accounts.id', 'portal_links.account_id')
      .select([
        'portal_links.id',
        'portal_links.account_id',
        'portal_links.contact_id',
        'portal_links.linked_at',
        'accounts.display_name',
        'accounts.email',
        'accounts.status',
      ])
      .where('portal_links.client_id', '=', clientId)
      .where('portal_links.ended_at', 'is', null)
      .orderBy('portal_links.linked_at')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      contactId: row.contact_id,
      name: row.display_name,
      email: row.email,
      accountStatus: row.status,
      linkedAt: row.linked_at,
    }));
  }

  /** Ends the link if it is the client's and still active; whether it did. The database keeps it ended. */
  async end(linkId: string, clientId: string, endedBy: string, trx: Kysely<Database>): Promise<{ accountId: string } | undefined> {
    return trx
      .updateTable('portal_links')
      .set({ ended_at: new Date(), ended_by: endedBy })
      .where('id', '=', linkId)
      .where('client_id', '=', clientId)
      .where('ended_at', 'is', null)
      .returning('account_id as accountId')
      .executeTakeFirst();
  }
}
