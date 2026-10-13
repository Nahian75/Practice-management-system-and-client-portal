export const AI_FEATURES = [
  'summarise_document',
  'draft_correspondence',
  'extract_chronology',
  'review_clauses',
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_DRAFT_TYPES = [
  'document_summary',
  'correspondence_draft',
  'chronology',
  'clause_notes',
] as const;

export type AiDraftType = (typeof AI_DRAFT_TYPES)[number];

export const AI_REVIEW_DECISIONS = ['accepted', 'modified', 'rejected'] as const;

export type AiReviewDecision = (typeof AI_REVIEW_DECISIONS)[number];

export interface StructuredCitation {
  sourceDocumentId: string;
  documentTitle: string;
  pageNumber?: number;
  quote: string;
}

export interface AiDocumentContext {
  id: string;
  title: string;
  content: string;
}

export interface AiPromptRequest {
  feature: AiFeature;
  matterId: string;
  title: string;
  instruction: string;
  draftType: AiDraftType;
  contextDocuments: AiDocumentContext[];
}

export interface AiPromptResponse {
  modelName: string;
  generatedText: string;
  structuredCitations: StructuredCitation[];
  confidenceNotes?: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}
