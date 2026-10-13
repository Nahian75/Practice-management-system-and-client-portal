export type AiFeature =
  | 'summarise_document'
  | 'draft_correspondence'
  | 'extract_chronology'
  | 'review_clauses';

export type AiDraftType =
  | 'document_summary'
  | 'correspondence_draft'
  | 'chronology'
  | 'clause_notes';

export type AiReviewDecision = 'accepted' | 'modified' | 'rejected';

export interface StructuredCitation {
  sourceDocumentId: string;
  documentTitle: string;
  pageNumber?: number;
  quote: string;
}

export interface AiDraftSummary {
  id: string;
  requestId: string;
  matterId: string;
  draftType: AiDraftType;
  title: string;
  createdAt: string;
  reviewStatus: 'pending' | 'reviewed';
  reviewDecision: AiReviewDecision | null;
}

export interface AiDraftDetail extends AiDraftSummary {
  generatedText: string;
  structuredCitations: StructuredCitation[];
  confidenceNotes: string | null;
  request: {
    actorId: string;
    feature: AiFeature;
    modelName: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    status: string;
  };
  review: {
    reviewerId: string;
    decision: AiReviewDecision;
    finalText: string | null;
    feedbackReason: string | null;
    promotedToDocumentId: string | null;
    promotedToTaskId: string | null;
    reviewedAt: string;
  } | null;
}

export interface AiConfiguration {
  id: string;
  provider: string;
  modelName: string;
  endpointUrl: string | null;
  maxTokensPerRequest: number;
  monthlyTokenBudget: number;
  tokensUsedThisMonth: number;
  budgetResetOn: string;
  enabled: boolean;
  updatedAt: string;
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

export interface AiAuditEvent {
  id: string;
  actorId: string;
  actorName: string;
  matterId: string;
  matterTitle: string;
  feature: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: string;
  createdAt: string;
}
