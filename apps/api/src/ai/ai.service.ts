import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AI_PROVIDER_TOKEN, type AiProvider } from './ai-provider.interface.js';
import {
  AiRepository,
  type AiAuditRow,
  type AiConfigRecord,
  type AiDraftDetail,
  type AiDraftSummary,
} from './ai.repository.js';
import type {
  AiDraftType,
  AiFeature,
  AiPromptRequest,
  AiReviewDecision,
  StructuredCitation,
} from './ai.types.js';

export interface GenerateDraftInput {
  feature: AiFeature;
  draftType: AiDraftType;
  title: string;
  instruction: string;
  contextDocuments?: Array<{ id: string; title: string; content: string }>;
}

export interface ReviewDraftInput {
  decision: AiReviewDecision;
  finalText?: string | null;
  feedbackReason?: string | null;
  promotedToDocumentId?: string | null;
  promotedToTaskId?: string | null;
}

@Injectable()
export class AiService {
  constructor(
    private readonly repository: AiRepository,
    @Inject(AI_PROVIDER_TOKEN) private readonly aiProvider: AiProvider,
  ) {}

  async readConfiguration(): Promise<AiConfigRecord> {
    const config = await this.repository.readConfiguration();
    if (!config) {
      throw new NotFoundException('AI configuration not initialized');
    }
    return config;
  }

  async updateConfiguration(
    actorId: string,
    params: {
      provider: string;
      modelName: string;
      endpointUrl?: string | null;
      maxTokensPerRequest: number;
      monthlyTokenBudget: number;
      enabled: boolean;
    },
  ): Promise<AiConfigRecord> {
    await this.repository.updateConfiguration(
      actorId,
      params.provider,
      params.modelName,
      params.endpointUrl ?? null,
      params.maxTokensPerRequest,
      params.monthlyTokenBudget,
      params.enabled,
    );
    return this.readConfiguration();
  }

  async generateDraft(
    actorId: string,
    matterId: string,
    input: GenerateDraftInput,
  ): Promise<{
    requestId: string;
    draftId: string;
    generatedText: string;
    structuredCitations: StructuredCitation[];
    confidenceNotes?: string;
  }> {
    // Assert matter access early
    await this.repository.assertMatterAccess(actorId, matterId);

    const contextDocuments = input.contextDocuments ?? [];

    const promptRequest: AiPromptRequest = {
      feature: input.feature,
      matterId,
      title: input.title,
      instruction: input.instruction,
      draftType: input.draftType,
      contextDocuments,
    };

    const assembledPromptText = JSON.stringify({
      feature: promptRequest.feature,
      title: promptRequest.title,
      instruction: promptRequest.instruction,
      docs: promptRequest.contextDocuments.map((d) => ({ id: d.id, len: d.content.length })),
    });
    const promptHash = createHash('sha256').update(assembledPromptText).digest();

    const result = await this.aiProvider.generate(promptRequest);

    const { requestId, draftId } = await this.repository.recordGeneration(
      actorId,
      matterId,
      input.feature,
      result.modelName,
      result.promptTokens,
      result.completionTokens,
      result.latencyMs,
      promptHash,
      input.draftType,
      input.title,
      result.generatedText,
      result.structuredCitations,
      result.confidenceNotes,
    );

    return {
      requestId,
      draftId,
      generatedText: result.generatedText,
      structuredCitations: result.structuredCitations,
      confidenceNotes: result.confidenceNotes,
    };
  }

  async reviewDraft(
    actorId: string,
    matterId: string,
    draftId: string,
    input: ReviewDraftInput,
  ): Promise<{ reviewId: string }> {
    await this.repository.assertMatterAccess(actorId, matterId);

    const reviewId = await this.repository.recordReview(
      actorId,
      draftId,
      input.decision,
      input.finalText,
      input.feedbackReason,
      input.promotedToDocumentId,
      input.promotedToTaskId,
    );
    return { reviewId };
  }

  async listMatterDrafts(actorId: string, matterId: string): Promise<AiDraftSummary[]> {
    return this.repository.listMatterDrafts(actorId, matterId);
  }

  async readMatterDraft(
    actorId: string,
    matterId: string,
    draftId: string,
  ): Promise<AiDraftDetail> {
    const draft = await this.repository.readMatterDraft(actorId, matterId, draftId);
    if (!draft) {
      throw new NotFoundException('AI draft not found');
    }
    return draft;
  }

  async listAuditEvents(limit = 100): Promise<AiAuditRow[]> {
    return this.repository.listAuditEvents(limit);
  }
}
