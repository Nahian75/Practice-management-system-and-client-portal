import type { DocumentCategory } from './documents';
import type { MatterType } from './matters';

export interface PortalMatter {
  id: string;
  reference: string;
  title: string;
  matterType: MatterType;
  status: 'open' | 'closed';
  openedAt: string;
  team: { displayName: string; role: 'supervising_partner' | 'fee_earner' }[];
}

export interface PortalDocument {
  id: string;
  title: string;
  category: DocumentCategory;
  createdAt: string;
  latest: { fileName: string; mediaType: string; sizeBytes: number; uploadedAt: string };
}

/** The latest shared version, through the same-site API pass-through. */
export const portalContentPath = (documentId: string) => `/api/portal/documents/${encodeURIComponent(documentId)}/content`;

export interface PortalEvidenceRequest {
  id: string;
  evidenceType: string;
  instructions: string;
  dueOn: string;
  state: 'open' | 'submitted';
  submittedAt: string | null;
}
