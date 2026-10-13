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

export interface ChronologyEntry {
  date: string;
  time?: string | null;
  eventDescription: string;
  actorsInvolved: string[];
  sourceDocumentId: string;
  sourceDocumentTitle: string;
  pageNumber?: number | null;
  quote: string;
  importance?: 'critical' | 'material' | 'background';
}

export interface DocumentChunk {
  chunkIndex: number;
  totalChunks: number;
  documentId: string;
  documentTitle: string;
  text: string;
  startChar: number;
  endChar: number;
  estimatedTokens: number;
}

export interface GroundingVerificationResult {
  grounded: boolean;
  verificationScore: number;
  verifiedCitations: Array<StructuredCitation & { verified: boolean; matchSimilarity: number }>;
  unverifiedCount: number;
  hallucinationWarning?: string | null;
}

export interface AiSupervisoryMetrics {
  monthlyBudget: {
    monthlyTokenBudget: number;
    tokensUsedThisMonth: number;
    budgetResetOn: string;
    percentUsed: number;
  };
  totalRequestsCount: number;
  requestsByFeature: Record<string, number>;
  reviewDecisions: {
    accepted: number;
    modified: number;
    rejected: number;
    pending: number;
  };
  securityAndCompliance: {
    injectionsDetectedCount: number;
    unverifiedCitationsCount: number;
  };
  topMattersUsage: Array<{
    matterId: string;
    matterTitle: string;
    totalTokens: number;
    requestCount: number;
  }>;
}

export interface MatterAiMetrics {
  matterId: string;
  tokensUsedThisMonth: number;
  matterTokenAllowance: number;
  percentUsed: number;
  totalRequests: number;
  totalDrafts: number;
  pendingReviews: number;
}

