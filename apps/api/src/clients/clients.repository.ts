import { Inject, Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder, type Kysely, type Updateable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { ClientContactsTable, ClientIndividualsTable, ClientOrganisationsTable, Database } from '../database/schema.js';
import type {
  Address,
  Client,
  ClientPatch,
  ClientSummary,
  Contact,
  ContactDetails,
  ContactPatch,
  NewClient,
} from './client.js';

/**
 * The visibility rule from docs/clients.md, in one place. Every query that
 * returns or changes a client's details filters with it, so a forgotten check
 * cannot reach someone else's client. Matters widens it to the matter's team.
 */
export function visibleTo(viewerId: string) {
  return (eb: ExpressionBuilder<Database, 'clients'>) => eb('clients.responsible_id', '=', viewerId);
}

/** The name a client is known by: the legal name, or given names and family name. */
const clientName = sql<string>`coalesce(o.legal_name, i.given_names || ' ' || i.family_name)`;

interface CorrespondenceColumns {
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  town: string | null;
  postcode: string | null;
  country: string | null;
}

@Injectable()
export class ClientsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  /** Inserts the client and its details. Must run in a transaction: the database checks both exist at commit. */
  async insert(client: NewClient, createdBy: string, trx: Kysely<Database>): Promise<{ id: string; reference: string }> {
    const created = await trx
      .insertInto('clients')
      .values({ kind: client.kind, created_by: createdBy })
      .returning(['id', 'reference'])
      .executeTakeFirstOrThrow();

    const correspondence = correspondenceColumns(client);
    if (client.kind === 'individual') {
      await trx
        .insertInto('client_individuals')
        .values({
          client_id: created.id,
          title: client.title,
          given_names: client.givenNames,
          family_name: client.familyName,
          date_of_birth: client.dateOfBirth,
          ...correspondence,
        })
        .execute();
    } else {
      await trx
        .insertInto('client_organisations')
        .values({
          client_id: created.id,
          legal_name: client.legalName,
          organisation_type: client.organisationType,
          registration_number: client.registrationNumber,
          ...correspondence,
        })
        .execute();
    }
    return created;
  }

  /** The client, if `viewerId` may see it. */
  async findVisible(clientId: string, viewerId: string, executor: Kysely<Database> = this.db): Promise<Client | undefined> {
    const row = await executor
      .selectFrom('clients')
      .leftJoin('client_individuals as i', 'i.client_id', 'clients.id')
      .leftJoin('client_organisations as o', 'o.client_id', 'clients.id')
      .select([
        'clients.id',
        'clients.reference',
        'clients.kind',
        'clients.status',
        'clients.created_at',
        'i.title',
        'i.given_names',
        'i.family_name',
        'i.date_of_birth',
        'o.legal_name',
        'o.organisation_type',
        'o.registration_number',
      ])
      .select((eb) => [
        eb.fn.coalesce('i.email', 'o.email').as('email'),
        eb.fn.coalesce('i.phone', 'o.phone').as('phone'),
        eb.fn.coalesce('i.address_line1', 'o.address_line1').as('address_line1'),
        eb.fn.coalesce('i.address_line2', 'o.address_line2').as('address_line2'),
        eb.fn.coalesce('i.town', 'o.town').as('town'),
        eb.fn.coalesce('i.postcode', 'o.postcode').as('postcode'),
        eb.fn.coalesce('i.country', 'o.country').as('country'),
      ])
      .where('clients.id', '=', clientId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }

    const record = {
      id: row.id,
      reference: row.reference,
      status: row.status,
      createdAt: row.created_at,
      email: row.email,
      phone: row.phone,
      address: addressFrom(row),
    };
    if (row.kind === 'individual') {
      return {
        ...record,
        kind: 'individual',
        title: row.title,
        givenNames: required(row.given_names),
        familyName: required(row.family_name),
        dateOfBirth: row.date_of_birth,
      };
    }
    return {
      ...record,
      kind: 'organisation',
      legalName: required(row.legal_name),
      organisationType: required(row.organisation_type),
      registrationNumber: row.registration_number,
      contacts: await this.visibleContacts(clientId, viewerId, executor),
    };
  }

  /** The client's contacts, active ones first, if `viewerId` may see the client. */
  async visibleContacts(clientId: string, viewerId: string, executor: Kysely<Database> = this.db): Promise<Contact[]> {
    const rows = await this.contactsOfVisibleClient(clientId, viewerId, executor)
      .orderBy('client_contacts.active', 'desc')
      .orderBy('client_contacts.family_name')
      .orderBy('client_contacts.given_names')
      .execute();
    return rows.map(contactFrom);
  }

  /** One contact of the client, if `viewerId` may see the client. */
  async findVisibleContact(
    clientId: string,
    contactId: string,
    viewerId: string,
    executor: Kysely<Database> = this.db,
  ): Promise<Contact | undefined> {
    const row = await this.contactsOfVisibleClient(clientId, viewerId, executor)
      .where('client_contacts.id', '=', contactId)
      .executeTakeFirst();
    return row && contactFrom(row);
  }

  private contactsOfVisibleClient(clientId: string, viewerId: string, executor: Kysely<Database>) {
    return executor
      .selectFrom('client_contacts')
      .innerJoin('clients', 'clients.id', 'client_contacts.client_id')
      .select([
        'client_contacts.id',
        'client_contacts.given_names',
        'client_contacts.family_name',
        'client_contacts.job_title',
        'client_contacts.email',
        'client_contacts.phone',
        'client_contacts.active',
      ])
      .where('clients.id', '=', clientId)
      .where(visibleTo(viewerId));
  }

  async insertContact(clientId: string, contact: ContactDetails, trx: Kysely<Database>): Promise<string> {
    const { id } = await trx
      .insertInto('client_contacts')
      .values({
        client_id: clientId,
        given_names: contact.givenNames,
        family_name: contact.familyName,
        job_title: contact.jobTitle,
        email: contact.email,
        phone: contact.phone,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  /** Writes the fields present in `patch`. The caller has checked visibility and locked the client. */
  async updateContact(contactId: string, patch: ContactPatch, trx: Kysely<Database>): Promise<void> {
    const columns: Updateable<ClientContactsTable> = {
      ...(patch.givenNames !== undefined && { given_names: patch.givenNames }),
      ...(patch.familyName !== undefined && { family_name: patch.familyName }),
      ...(patch.jobTitle !== undefined && { job_title: patch.jobTitle }),
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.active !== undefined && { active: patch.active }),
    };
    await trx.updateTable('client_contacts').set(columns).where('id', '=', contactId).execute();
  }

  /**
   * Clients `viewerId` may see, newest first, `limit` at a time. `before` is
   * the reference of the last client on the previous page.
   */
  listVisible(viewerId: string, page: { before?: string; limit: number }): Promise<ClientSummary[]> {
    let query = this.db
      .selectFrom('clients')
      .leftJoin('client_individuals as i', 'i.client_id', 'clients.id')
      .leftJoin('client_organisations as o', 'o.client_id', 'clients.id')
      .select(['clients.id', 'clients.reference', 'clients.kind', clientName.as('name')])
      .where(visibleTo(viewerId));
    if (page.before !== undefined) {
      const before = page.before;
      query = query.where('clients.number', '<', (eb) =>
        eb.selectFrom('clients').select('number').where('reference', '=', before),
      );
    }
    return query.orderBy('clients.number', 'desc').limit(page.limit).execute();
  }

  /**
   * Every client whose reference is `text` or whose name contains it. Not
   * limited by visibility: it returns summaries only, so people can avoid
   * creating a client twice. An exact reference comes first.
   */
  search(text: string, limit: number, executor: Kysely<Database> = this.db): Promise<ClientSummary[]> {
    const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    return executor
      .selectFrom('clients')
      .leftJoin('client_individuals as i', 'i.client_id', 'clients.id')
      .leftJoin('client_organisations as o', 'o.client_id', 'clients.id')
      .select(['clients.id', 'clients.reference', 'clients.kind', clientName.as('name')])
      .where((eb) => eb.or([eb('clients.reference', '=', text.toUpperCase()), eb(clientName, 'ilike', pattern)]))
      .orderBy(sql`clients.reference = ${text.toUpperCase()}`, 'desc')
      .orderBy(clientName)
      .orderBy('clients.number')
      .limit(limit)
      .execute();
  }

  /**
   * Locks the client's details row until the transaction ends, if `viewerId`
   * may see the client. Returns false when it may not, or does not exist.
   */
  async lockVisible(clientId: string, viewerId: string, trx: Kysely<Database>): Promise<boolean> {
    const visible = trx.selectFrom('clients').select('clients.id').where('clients.id', '=', clientId).where(visibleTo(viewerId));
    const individual = await trx
      .selectFrom('client_individuals')
      .select('client_id')
      .where('client_id', 'in', visible)
      .forUpdate()
      .executeTakeFirst();
    const organisation = await trx
      .selectFrom('client_organisations')
      .select('client_id')
      .where('client_id', 'in', visible)
      .forUpdate()
      .executeTakeFirst();
    return Boolean(individual ?? organisation);
  }

  /** Writes the fields present in `patch`. The caller has checked the kind and locked the row. */
  async updateDetails(clientId: string, patch: ClientPatch, trx: Kysely<Database>): Promise<void> {
    const correspondence: Updateable<CorrespondenceColumns> = {
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.address !== undefined && addressColumns(patch.address)),
    };

    if (patch.kind === 'individual') {
      const columns: Updateable<ClientIndividualsTable> = {
        ...correspondence,
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.givenNames !== undefined && { given_names: patch.givenNames }),
        ...(patch.familyName !== undefined && { family_name: patch.familyName }),
        ...(patch.dateOfBirth !== undefined && { date_of_birth: patch.dateOfBirth }),
      };
      await trx.updateTable('client_individuals').set(columns).where('client_id', '=', clientId).execute();
    } else {
      const columns: Updateable<ClientOrganisationsTable> = {
        ...correspondence,
        ...(patch.legalName !== undefined && { legal_name: patch.legalName }),
        ...(patch.organisationType !== undefined && { organisation_type: patch.organisationType }),
        ...(patch.registrationNumber !== undefined && { registration_number: patch.registrationNumber }),
      };
      await trx.updateTable('client_organisations').set(columns).where('client_id', '=', clientId).execute();
    }
  }

  /**
   * Serialises one person's searches until the transaction ends, so requests
   * sent in parallel cannot all pass the hourly limit before any is recorded.
   */
  async lockSearchesBy(accountId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`app.client_search:${accountId}`}, 0))`.execute(trx);
  }

  /**
   * Serialises takeovers of one client until the transaction ends, so two
   * partners taking it over at once are answered one after the other.
   */
  async lockResponsibility(clientId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`app.client_responsibility:${clientId}`}, 0))`.execute(trx);
  }

  /** Who is responsible for the client, and whether their account is still in use. Not limited by visibility. */
  findResponsible(clientId: string, trx: Kysely<Database>) {
    return trx
      .selectFrom('clients')
      .innerJoin('accounts', 'accounts.id', 'clients.responsible_id')
      .select(['clients.reference', 'clients.responsible_id', 'accounts.status'])
      .where('clients.id', '=', clientId)
      .executeTakeFirst();
  }

  /** Records a change of responsibility. The database checks the rules and applies it. */
  async recordResponsibilityChange(
    change: { clientId: string; fromAccountId: string; toAccountId: string; reason: string },
    trx: Kysely<Database>,
  ): Promise<string> {
    const { id } = await trx
      .insertInto('client_responsibility_changes')
      .values({
        client_id: change.clientId,
        from_account_id: change.fromAccountId,
        to_account_id: change.toAccountId,
        reason: change.reason,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}

function correspondenceColumns(client: NewClient): CorrespondenceColumns {
  return { email: client.email, phone: client.phone, ...addressColumns(client.address) };
}

function addressColumns(address: Address | null): Omit<CorrespondenceColumns, 'email' | 'phone'> {
  return {
    address_line1: address?.line1 ?? null,
    address_line2: address?.line2 ?? null,
    town: address?.town ?? null,
    postcode: address?.postcode ?? null,
    country: address?.country ?? null,
  };
}

function contactFrom(row: {
  id: string;
  given_names: string;
  family_name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
}): Contact {
  return {
    id: row.id,
    givenNames: row.given_names,
    familyName: row.family_name,
    jobTitle: row.job_title,
    email: row.email,
    phone: row.phone,
    active: row.active,
  };
}

function addressFrom(row: CorrespondenceColumns): Address | null {
  if (row.address_line1 === null || row.town === null || row.country === null) {
    return null;
  }
  return { line1: row.address_line1, line2: row.address_line2, town: row.town, postcode: row.postcode, country: row.country };
}

/** A details column the database guarantees for this kind, but a left join types as nullable. */
function required<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Client details row is missing');
  }
  return value;
}
