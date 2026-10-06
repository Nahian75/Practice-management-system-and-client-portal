import { Inject, Injectable } from '@nestjs/common';
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import { visibleTo as clientVisibleTo } from '../clients/clients.repository.js';
import { DATABASE } from '../database/database.module.js';
import type {
  AccountKind,
  AccountStatus,
  ClientKind,
  Database,
  DocumentCategory,
  DocumentMediaType,
  MatterStatus,
  MatterTeamRole,
  MatterType,
} from '../database/schema.js';

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

export interface ClientPortalMatter {
  id: string;
  reference: string;
  title: string;
  matterType: MatterType;
  status: Extract<MatterStatus, 'open' | 'closed'>;
  openedAt: Date;
  team: { displayName: string; role: MatterTeamRole }[];
}

export interface ClientPortalDocument {
  id: string;
  title: string;
  category: DocumentCategory;
  createdAt: Date;
  latest: { fileName: string; mediaType: DocumentMediaType; sizeBytes: number; uploadedAt: Date };
}

export interface ClientPortalDownload {
  matterId: string;
  number: number;
  fileName: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  storageKey: string;
  sealedKey: SealedSecret;
}

type PortalMatterFilter = (eb: ExpressionBuilder<Database, 'matters'>) => Expression<SqlBool>;

/** A current portal link to this matter's client, including a current organisation contact. */
export function visibleInPortal(accountId: string): PortalMatterFilter {
  return (eb) =>
    eb.exists(
      eb
        .selectFrom('portal_links')
        .innerJoin('accounts', 'accounts.id', 'portal_links.account_id')
        .innerJoin('clients', 'clients.id', 'portal_links.client_id')
        .select('portal_links.id')
        .whereRef('portal_links.client_id', '=', 'matters.client_id')
        .where('portal_links.account_id', '=', accountId)
        .where('portal_links.ended_at', 'is', null)
        .where('accounts.kind', '=', 'client')
        .where('accounts.status', '=', 'active')
        .where((link) =>
          link.or([
            link.and([
              link('clients.kind', '=', 'individual'),
              link('portal_links.contact_id', 'is', null),
              link.exists(
                link
                  .selectFrom('client_individuals')
                  .select('client_individuals.client_id')
                  .whereRef('client_individuals.client_id', '=', 'portal_links.client_id')
                  .whereRef('client_individuals.email', '=', 'accounts.email'),
              ),
            ]),
            link.and([
              link('clients.kind', '=', 'organisation'),
              link.exists(
                link
                  .selectFrom('client_contacts')
                  .select('client_contacts.id')
                  .whereRef('client_contacts.id', '=', 'portal_links.contact_id')
                  .whereRef('client_contacts.client_id', '=', 'portal_links.client_id')
                  .whereRef('client_contacts.email', '=', 'accounts.email')
                  .where('client_contacts.active', '=', true),
              ),
            ]),
          ]),
        ),
    );
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

  /** One page of open or closed matters reachable through the account's live portal links. */
  async clientMatters(accountId: string, page: { before?: string; limit: number }): Promise<ClientPortalMatter[]> {
    const rows = await this.db
      .selectFrom('matters')
      .select(['matters.id', 'matters.reference', 'matters.title', 'matters.matter_type', 'matters.status', 'matters.opened_at'])
      .where('matters.status', 'in', ['open', 'closed'])
      .where(visibleInPortal(accountId))
      .$if(page.before !== undefined, (query) => query.where('matters.id', '<', page.before as string))
      .orderBy('matters.id', 'desc')
      .limit(page.limit)
      .execute();
    return this.withClientTeam(rows, accountId);
  }

  /** One client-safe matter, if its portal link is live now. */
  async clientMatter(matterId: string, accountId: string): Promise<ClientPortalMatter | undefined> {
    const row = await this.db
      .selectFrom('matters')
      .select(['matters.id', 'matters.reference', 'matters.title', 'matters.matter_type', 'matters.status', 'matters.opened_at'])
      .where('matters.id', '=', matterId)
      .where('matters.status', 'in', ['open', 'closed'])
      .where(visibleInPortal(accountId))
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return (await this.withClientTeam([row], accountId))[0];
  }

  /** Shared, unwithdrawn documents and only their latest version, after checking the matter again. */
  async clientDocuments(
    matterId: string,
    accountId: string,
    page: { before?: string; limit: number },
  ): Promise<ClientPortalDocument[] | undefined> {
    if (!(await this.clientMatter(matterId, accountId))) {
      return undefined;
    }
    const rows = await this.db
      .selectFrom('documents')
      .innerJoin('matters', 'matters.id', 'documents.matter_id')
      .innerJoin('document_versions', 'document_versions.document_id', 'documents.id')
      .select([
        'documents.id',
        'documents.title',
        'documents.category',
        'documents.created_at',
        'document_versions.file_name',
        'document_versions.media_type',
        'document_versions.size_bytes',
        'document_versions.uploaded_at',
      ])
      .where('documents.matter_id', '=', matterId)
      .where('documents.shared_with_client', '=', true)
      .where('matters.status', 'in', ['open', 'closed'])
      .where(visibleInPortal(accountId))
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id', '=', 'documents.id'))),
      )
      .where('document_versions.number', '=', (eb) =>
        eb
          .selectFrom('document_versions as latest')
          .select((latest) => latest.fn.max('latest.number').as('number'))
          .whereRef('latest.document_id', '=', 'documents.id'),
      )
      .$if(page.before !== undefined, (query) => query.where('documents.id', '<', page.before as string))
      .orderBy('documents.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      createdAt: row.created_at,
      latest: { fileName: row.file_name, mediaType: row.media_type, sizeBytes: row.size_bytes, uploadedAt: row.uploaded_at },
    }));
  }

  /** The latest shared version, only while the client can still reach its matter. */
  async clientDownload(documentId: string, accountId: string): Promise<ClientPortalDownload | undefined> {
    const row = await this.db
      .selectFrom('document_versions')
      .innerJoin('documents', 'documents.id', 'document_versions.document_id')
      .innerJoin('matters', 'matters.id', 'documents.matter_id')
      .select([
        'documents.matter_id',
        'document_versions.number',
        'document_versions.file_name',
        'document_versions.media_type',
        'document_versions.size_bytes',
        'document_versions.storage_key',
        'document_versions.key_version',
        'document_versions.key_nonce',
        'document_versions.wrapped_key',
        'document_versions.key_tag',
      ])
      .where('documents.id', '=', documentId)
      .where('documents.shared_with_client', '=', true)
      .where('matters.status', 'in', ['open', 'closed'])
      .where(visibleInPortal(accountId))
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id', '=', 'documents.id'))),
      )
      .where('document_versions.number', '=', (eb) =>
        eb
          .selectFrom('document_versions as latest')
          .select((latest) => latest.fn.max('latest.number').as('number'))
          .whereRef('latest.document_id', '=', 'documents.id'),
      )
      .executeTakeFirst();
    return row
      ? {
          matterId: row.matter_id,
          number: row.number,
          fileName: row.file_name,
          mediaType: row.media_type,
          sizeBytes: row.size_bytes,
          storageKey: row.storage_key,
          sealedKey: { keyVersion: row.key_version, nonce: row.key_nonce, ciphertext: row.wrapped_key, authTag: row.key_tag },
        }
      : undefined;
  }

  private async withClientTeam(
    rows: {
      id: string;
      reference: string;
      title: string;
      matter_type: MatterType;
      status: MatterStatus;
      opened_at: Date;
    }[],
    accountId: string,
  ): Promise<ClientPortalMatter[]> {
    if (rows.length === 0) {
      return [];
    }
    const teams = await this.db
      .selectFrom('matter_team')
      .innerJoin('accounts', 'accounts.id', 'matter_team.account_id')
      .innerJoin('matters', 'matters.id', 'matter_team.matter_id')
      .select(['matter_team.matter_id', 'accounts.display_name', 'matter_team.role'])
      .where('matter_team.matter_id', 'in', rows.map((row) => row.id))
      .where('matter_team.removed_at', 'is', null)
      .where(visibleInPortal(accountId))
      .orderBy('matter_team.role', 'desc')
      .orderBy('accounts.display_name')
      .execute();
    const reachable = new Set(teams.map((member) => member.matter_id));
    return rows
      .filter((row) => reachable.has(row.id))
      .map((row) => ({
        id: row.id,
        reference: row.reference,
        title: row.title,
        matterType: row.matter_type,
        status: row.status as ClientPortalMatter['status'],
        openedAt: row.opened_at,
        team: teams
          .filter((member) => member.matter_id === row.id)
          .map((member) => ({ displayName: member.display_name, role: member.role })),
      }));
  }
}
