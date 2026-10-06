/** Documents as the API returns them (apps/api/src/documents), and how they are shown. */

export const CATEGORY_LABELS = {
  correspondence: 'Correspondence',
  contract: 'Contract',
  evidence: 'Evidence',
  identity: 'Identity',
  court: 'Court',
  other: 'Other',
} as const;

export type DocumentCategory = keyof typeof CATEGORY_LABELS;

/** The kinds of file the API accepts, for the file picker. The API checks the content itself. */
export const ACCEPTED_FILES = '.pdf,.docx,.xlsx,.pptx,.txt,.eml,.jpg,.jpeg,.png';
export const ACCEPTED_DESCRIPTION = 'PDF, Word, Excel, PowerPoint, text, email (.eml), JPEG or PNG, up to 50 MB';

/** 50 MB, as the API's own limit. Checked in the page too, so nobody waits for an upload that will be refused. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export interface VersionSummary {
  number: number;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  category: DocumentCategory;
  createdAt: string;
  latest: VersionSummary;
}

export interface DocumentDetails {
  id: string;
  matterId: string;
  title: string;
  category: DocumentCategory;
  createdAt: string;
  versions: (VersionSummary & { uploadedBy: { accountId: string; displayName: string } })[];
  withdrawal: { withdrawnBy: { accountId: string; displayName: string }; reason: string; withdrawnAt: string } | null;
}

/** Where a version is downloaded from, through the web app's pass-through to the API. */
export const contentPath = (documentId: string, number: number) =>
  `/api/documents/${encodeURIComponent(documentId)}/versions/${number}/content`;

const SIZE = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

/** A file size as people read it: "820 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${SIZE.format(Math.max(1, bytes / 1024))} KB`;
  }
  return `${SIZE.format(bytes / (1024 * 1024))} MB`;
}
