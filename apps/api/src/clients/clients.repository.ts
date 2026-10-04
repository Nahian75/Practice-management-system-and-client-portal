import { Inject, Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder, type Kysely, type Updateable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { ClientIndividualsTable, ClientOrganisationsTable, Database } from '../database/schema.js';
import type { Address, Client, ClientPatch, ClientSummary, NewClient } from './client.js';

/**
 * The visibility rule from docs/clients.md, in one place. Every query that
 * returns or changes a client's details filters with it, so a forgotten check
 * cannot reach someone else's client. Matters widens it to the matter's team.
 */
export function visibleTo(viewerId: string) {
  return (eb: ExpressionBuilder<Database, 'clients'>) => eb('clients.created_by', '=', viewerId);
}

/** The name a client is known by: the legal name, or given names and family name. */
const clientName = sql<string>`coalesce(o.legal_name, i.given_names || ' ' || i.family_name)`;

interface ContactColumns {
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

    const contact = contactColumns(client);
    if (client.kind === 'individual') {
      await trx
        .insertInto('client_individuals')
        .values({
          client_id: created.id,
          title: client.title,
          given_names: client.givenNames,
          family_name: client.familyName,
          date_of_birth: client.dateOfBirth,
          ...contact,
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
          ...contact,
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
    };
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
  search(text: string, limit: number): Promise<ClientSummary[]> {
    const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    return this.db
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
    const contact: Updateable<ContactColumns> = {
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.address !== undefined && addressColumns(patch.address)),
    };

    if (patch.kind === 'individual') {
      const columns: Updateable<ClientIndividualsTable> = {
        ...contact,
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.givenNames !== undefined && { given_names: patch.givenNames }),
        ...(patch.familyName !== undefined && { family_name: patch.familyName }),
        ...(patch.dateOfBirth !== undefined && { date_of_birth: patch.dateOfBirth }),
      };
      await trx.updateTable('client_individuals').set(columns).where('client_id', '=', clientId).execute();
    } else {
      const columns: Updateable<ClientOrganisationsTable> = {
        ...contact,
        ...(patch.legalName !== undefined && { legal_name: patch.legalName }),
        ...(patch.organisationType !== undefined && { organisation_type: patch.organisationType }),
        ...(patch.registrationNumber !== undefined && { registration_number: patch.registrationNumber }),
      };
      await trx.updateTable('client_organisations').set(columns).where('client_id', '=', clientId).execute();
    }
  }

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}

function contactColumns(client: NewClient): ContactColumns {
  return { email: client.email, phone: client.phone, ...addressColumns(client.address) };
}

function addressColumns(address: Address | null): Omit<ContactColumns, 'email' | 'phone'> {
  return {
    address_line1: address?.line1 ?? null,
    address_line2: address?.line2 ?? null,
    town: address?.town ?? null,
    postcode: address?.postcode ?? null,
    country: address?.country ?? null,
  };
}

function addressFrom(row: ContactColumns): Address | null {
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
