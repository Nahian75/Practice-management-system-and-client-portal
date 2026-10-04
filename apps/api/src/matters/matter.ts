import type { ClientKind, ConflictMatchRow, MatterStatus, MatterTeamRole, MatterType, PartyRole } from '../database/schema.js';

export interface NewParty {
  role: PartyRole;
  kind: ClientKind;
  name: string;
}

export interface Party extends NewParty {
  id: string;
}

/** What is given when a matter is opened. */
export interface NewMatter {
  clientId: string;
  title: string;
  matterType: MatterType;
  supervisingPartnerId: string;
  feeEarnerIds: string[];
  conflictCheckId: string;
  parties: NewParty[];
}

/** A possible conflict, shown by reference only: enough to judge it, nothing more. */
export interface PossibleConflict {
  checkedName: string;
  matchedName: string;
  relation: ConflictMatchRow['relation'];
  clientReference: string;
  matterReference: string | null;
}

export interface ConflictCheck {
  id: string;
  names: string[];
  /** The 50 strongest possible matches. */
  matches: PossibleConflict[];
  /** How many possible matches there were in all. */
  matchCount: number;
  createdAt: Date;
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
  parties: Party[];
}
