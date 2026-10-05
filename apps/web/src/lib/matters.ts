/** Matters as the API returns them (apps/api/src/matters), and how their codes are shown. */

export const MATTER_TYPE_LABELS = {
  residential_property: 'Residential property',
  commercial_property: 'Commercial property',
  family: 'Family',
  litigation: 'Litigation',
  employment: 'Employment',
  wills_probate: 'Wills and probate',
  corporate: 'Corporate',
  immigration: 'Immigration',
  crime: 'Crime',
  other: 'Other',
} as const;

export const MATTER_STATUS_LABELS = { awaiting_clearance: 'Awaiting conflict clearance', open: 'Open', closed: 'Closed' } as const;

export const PARTY_ROLE_LABELS = { opponent: 'Opponent', opponent_solicitor: "Opponent's solicitor", other: 'Other party' } as const;

export const RELATION_LABELS = {
  client: 'Client',
  contact: 'Contact at a client',
  opponent: 'Opponent',
  opponent_solicitor: "Opponent's solicitor",
  other_party: 'Other party',
} as const;

export const TEAM_ROLE_LABELS = { supervising_partner: 'Supervising partner', fee_earner: 'Fee earner' } as const;

export type MatterType = keyof typeof MATTER_TYPE_LABELS;
export type PartyRole = keyof typeof PARTY_ROLE_LABELS;

export interface MatterSummary {
  id: string;
  reference: string;
  title: string;
  matterType: MatterType;
  status: keyof typeof MATTER_STATUS_LABELS;
  client: { id: string; reference: string; kind: 'individual' | 'organisation'; name: string };
}

export interface Matter extends MatterSummary {
  openedAt: string;
  parties: { id: string; role: PartyRole; kind: 'individual' | 'organisation'; name: string }[];
  team: { accountId: string; displayName: string; role: keyof typeof TEAM_ROLE_LABELS }[];
}

export interface ConflictCheck {
  id: string;
  names: string[];
  matchCount: number;
  createdAt: string;
  matches: {
    checkedName: string;
    matchedName: string;
    relation: keyof typeof RELATION_LABELS;
    clientReference: string;
    matterReference: string | null;
  }[];
  clearance: { clearedBy: { accountId: string; displayName: string }; reason: string; clearedAt: string } | null;
}

export interface Colleague {
  id: string;
  displayName: string;
  isPartner: boolean;
}
