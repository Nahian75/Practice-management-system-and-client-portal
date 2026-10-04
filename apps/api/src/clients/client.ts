import type { ClientKind, ClientStatus, OrganisationType } from '../database/schema.js';

export interface Address {
  line1: string;
  line2: string | null;
  town: string;
  postcode: string | null;
  /** ISO 3166 two-letter code, upper case. */
  country: string;
}

interface ClientDetails {
  email: string | null;
  phone: string | null;
  address: Address | null;
}

export interface IndividualDetails extends ClientDetails {
  kind: 'individual';
  title: string | null;
  givenNames: string;
  familyName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
}

export interface OrganisationDetails extends ClientDetails {
  kind: 'organisation';
  legalName: string;
  organisationType: OrganisationType;
  registrationNumber: string | null;
}

/** What is given when a client is created. */
export type NewClient = IndividualDetails | OrganisationDetails;

/**
 * A change to a client's details. A field left out stays as it is; `null`
 * clears an optional field. `kind` must match the client's.
 */
export type ClientPatch =
  | ({ kind: 'individual' } & Partial<Omit<IndividualDetails, 'kind'>>)
  | ({ kind: 'organisation' } & Partial<Omit<OrganisationDetails, 'kind'>>);

/** What a list or search shows: enough to recognise a client, nothing more. */
export interface ClientSummary {
  id: string;
  reference: string;
  kind: ClientKind;
  name: string;
}

interface ClientRecord {
  id: string;
  reference: string;
  status: ClientStatus;
  createdAt: Date;
}

export type Client = (IndividualDetails & ClientRecord) | (OrganisationDetails & ClientRecord);
