import { Inject, Injectable } from '@nestjs/common';
import type { ExpressionBuilder, Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import type { Address, Client, NewClient } from './client.js';

/**
 * The visibility rule from docs/clients.md, in one place. Every query that
 * returns a client's details filters with it, so a forgotten check cannot
 * return someone else's client. Matters widens it to the matter's team.
 */
export function visibleTo(viewerId: string) {
  return (eb: ExpressionBuilder<Database, 'clients'>) => eb('clients.created_by', '=', viewerId);
}

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
  async findVisible(clientId: string, viewerId: string): Promise<Client | undefined> {
    const row = await this.db
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

  /** Runs `work` in a transaction, for changes that must commit together. */
  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }
}

function contactColumns(client: NewClient): ContactColumns {
  return {
    email: client.email,
    phone: client.phone,
    address_line1: client.address?.line1 ?? null,
    address_line2: client.address?.line2 ?? null,
    town: client.address?.town ?? null,
    postcode: client.address?.postcode ?? null,
    country: client.address?.country ?? null,
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
