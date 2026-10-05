/** Clients as the API returns them (apps/api/src/clients). */

export interface ClientSummary {
  id: string;
  reference: string;
  kind: 'individual' | 'organisation';
  name: string;
}

export interface Address {
  line1: string;
  line2: string | null;
  town: string;
  postcode: string | null;
  country: string;
}

export interface Contact {
  id: string;
  givenNames: string;
  familyName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
}

interface ClientRecord {
  id: string;
  reference: string;
  status: 'active' | 'archived';
  createdAt: string;
  email: string | null;
  phone: string | null;
  address: Address | null;
}

export type Client =
  | (ClientRecord & {
      kind: 'individual';
      title: string | null;
      givenNames: string;
      familyName: string;
      dateOfBirth: string | null;
    })
  | (ClientRecord & {
      kind: 'organisation';
      legalName: string;
      organisationType: 'company' | 'llp' | 'partnership' | 'charity' | 'trust' | 'other';
      registrationNumber: string | null;
      contacts: Contact[];
    });

export function clientName(client: Client): string {
  return client.kind === 'organisation' ? client.legalName : [client.title, client.givenNames, client.familyName].filter(Boolean).join(' ');
}
