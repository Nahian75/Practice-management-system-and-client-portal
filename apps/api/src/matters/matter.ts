import type { ClientKind, MatterStatus, MatterTeamRole, MatterType } from '../database/schema.js';

/** What is given when a matter is opened. */
export interface NewMatter {
  clientId: string;
  title: string;
  matterType: MatterType;
  supervisingPartnerId: string;
  feeEarnerIds: string[];
}

export interface MatterSummary {
  id: string;
  reference: string;
  title: string;
  matterType: MatterType;
  status: MatterStatus;
  client: { id: string; reference: string; kind: ClientKind; name: string };
}

export interface TeamMember {
  accountId: string;
  displayName: string;
  role: MatterTeamRole;
}

export interface Matter extends MatterSummary {
  openedAt: Date;
  team: TeamMember[];
}
