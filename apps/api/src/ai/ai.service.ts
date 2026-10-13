import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AI_PROVIDER_TOKEN, type AiProvider } from './ai-provider.interface.js';
import {
  AiRepository,
  type AiAuditRow,
  type AiConfigRecord,
  type AiDraftDetail,
  type AiDraftSummary,
} from './ai.repository.js';
import { RedactionService } from './redaction.service.js';
import { PromptBuilderService } from './prompt-builder.service.js';
import { CitationGroundingService } from './citation-grounding.service.js';
import { DocumentChunkerService } from './document-chunker.service.js';
import { ChronologyExtractorService } from './chronology-extractor.service.js';
import { AttendanceNotesService } from './attendance-notes.service.js';
import type { DocumentCategory, TaskPriority } from '../database/schema.js';
import type {
  AiDraftType,
  AiFeature,
  AiPromptRequest,
  AiReviewDecision,
  AiSupervisoryMetrics,
  MatterAiMetrics,
  ChronologyEntry,
  DocumentChunk,
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
  promoteToDocument?: {
    title: string;
    category?: DocumentCategory;
  } | null;
  promoteToTask?: {
    title: string;
    description?: string | null;
    dueOn?: string | null;
    priority?: TaskPriority;
    assigneeId?: string | null;
  } | null;
}

@Injectable()
export class AiService {
  constructor(
    private readonly repository: AiRepository,
    @Inject(AI_PROVIDER_TOKEN) private readonly aiProvider: AiProvider,
    private readonly redaction: RedactionService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly citationGrounding: CitationGroundingService,
    private readonly documentChunker: DocumentChunkerService,
    private readonly chronologyExtractor: ChronologyExtractorService,
    private readonly attendanceNotes: AttendanceNotesService,
    private readonly audit: AuditService,
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

    await this.audit.record({
      actor: { type: 'user', id: actorId },
      action: 'ai.configuration_updated',
      outcome: 'success',
      metadata: {
        provider: params.provider,
        modelName: params.modelName,
        maxTokens: params.maxTokensPerRequest,
        monthlyBudget: params.monthlyTokenBudget,
        enabled: params.enabled,
      },
    });

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
    // 1. Assert matter access early
    await this.repository.assertMatterAccess(actorId, matterId);

    // 2. Enforce matter document ownership (ethical wall / domain isolation)
    const contextDocuments = input.contextDocuments ?? [];
    const docIds = contextDocuments.map((d) => d.id).filter(Boolean);
    const validOwnership = await this.repository.validateMatterDocumentOwnership(matterId, docIds);
    if (!validOwnership) {
      throw new ForbiddenException('One or more referenced documents do not belong to this matter');
    }

    // 2b. Pre-flight budgeting and rate limit checks (Step 18e)
    const config = await this.readConfiguration();
    if (!config.enabled) {
      throw new ForbiddenException('AI drafting assistant is disabled by firm policy');
    }

    const totalChars = input.instruction.length + contextDocuments.reduce((sum, d) => sum + d.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    if (estimatedTokens > config.maxTokensPerRequest) {
      throw new BadRequestException(
        `Estimated request tokens (${estimatedTokens}) exceed configured limit (${config.maxTokensPerRequest})`,
      );
    }

    if (config.tokensUsedThisMonth + estimatedTokens > config.monthlyTokenBudget) {
      throw new ForbiddenException(
        `Monthly firm AI token budget exhausted (${config.tokensUsedThisMonth} of ${config.monthlyTokenBudget} tokens used)`,
      );
    }

    const matterTokensUsed = await this.repository.getMatterTokenUsageThisMonth(matterId);
    if (matterTokensUsed + estimatedTokens > 150000) {
      throw new ForbiddenException(
        `Monthly AI token allowance for this matter is exhausted (${matterTokensUsed} tokens used)`,
      );
    }

    // 3. Pre-prompt redaction pipeline (data minimisation)
    const redactedInstruction = this.redaction.redact(input.instruction);
    let totalRedactions = redactedInstruction.stats.totalRedactions;

    const sanitizedDocs = contextDocuments.map((doc) => {
      const redactedDoc = this.redaction.redact(doc.content);
      totalRedactions += redactedDoc.stats.totalRedactions;
      return {
        id: doc.id,
        title: doc.title,
        content: redactedDoc.redactedText,
      };
    });

    // 4. Prompt assembly and indirect prompt-injection detection
    const promptRequest: AiPromptRequest = {
      feature: input.feature,
      matterId,
      title: input.title,
      instruction: redactedInstruction.redactedText,
      draftType: input.draftType,
      contextDocuments: sanitizedDocs,
    };

    const promptAssembly = this.promptBuilder.buildUserPrompt(promptRequest, sanitizedDocs);

    if (promptAssembly.isPotentialInjection) {
      await this.audit.record({
        actor: { type: 'user', id: actorId },
        action: 'ai.prompt_injection_detected',
        outcome: 'denied',
        resource: { type: 'matter', id: matterId },
        metadata: {
          feature: input.feature,
          reason: promptAssembly.injectionReason ?? 'Suspicious instruction pattern detected',
        },
      });
    }

    const assembledPromptText = JSON.stringify({
      system: promptAssembly.systemPrompt,
      user: promptAssembly.userPrompt,
    });
    const promptHash = createHash('sha256').update(assembledPromptText).digest();

    // 5. Dispatch to provider (offline mock or private cloud)
    const result = await this.aiProvider.generate(promptRequest);

    // 5b. Citation grounding verification (SRA Code 1.4 & 2.1 - hallucination defense)
    const grounding = this.citationGrounding.verifyCitations(
      result.structuredCitations,
      sanitizedDocs,
    );
    let finalConfidenceNotes = result.confidenceNotes ?? '';
    if (!grounding.grounded && grounding.hallucinationWarning) {
      finalConfidenceNotes = finalConfidenceNotes
        ? `${finalConfidenceNotes} | ${grounding.hallucinationWarning}`
        : grounding.hallucinationWarning;

      await this.audit.record({
        actor: { type: 'user', id: actorId },
        action: 'ai.citation_unverified',
        outcome: 'denied',
        resource: { type: 'matter', id: matterId },
        metadata: {
          unverifiedCount: grounding.unverifiedCount,
          verificationScore: grounding.verificationScore,
          feature: input.feature,
        },
      });
    }

    // 6. Record generation in PostgreSQL
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
      finalConfidenceNotes,
    );

    // 7. Record transactional audit event
    await this.audit.record({
      actor: { type: 'user', id: actorId },
      action: 'ai.draft_generated',
      outcome: 'success',
      resource: { type: 'matter', id: matterId },
      metadata: {
        requestId,
        draftId,
        feature: input.feature,
        draftType: input.draftType,
        totalTokens: result.promptTokens + result.completionTokens,
        redactionsCount: totalRedactions,
        isPotentialInjection: promptAssembly.isPotentialInjection,
        citationVerificationScore: grounding.verificationScore,
        citationsGrounded: grounding.grounded,
      },
    });

    return {
      requestId,
      draftId,
      generatedText: result.generatedText,
      structuredCitations: result.structuredCitations,
      confidenceNotes: finalConfidenceNotes,
    };
  }

  async summariseDocument(
    actorId: string,
    matterId: string,
    input: {
      title: string;
      instruction: string;
      contextDocuments?: Array<{ id: string; title: string; content: string }>;
    },
  ) {
    return this.generateDraft(actorId, matterId, {
      feature: 'summarise_document',
      draftType: 'document_summary',
      title: input.title,
      instruction: input.instruction,
      contextDocuments: input.contextDocuments,
    });
  }

  async extractChronology(
    actorId: string,
    matterId: string,
    input: {
      title: string;
      instruction: string;
      contextDocuments?: Array<{ id: string; title: string; content: string }>;
    },
  ) {
    return this.generateDraft(actorId, matterId, {
      feature: 'extract_chronology',
      draftType: 'chronology',
      title: input.title,
      instruction: input.instruction,
      contextDocuments: input.contextDocuments,
    });
  }

  chunkDocument(
    documentId: string,
    documentTitle: string,
    rawText: string,
  ): DocumentChunk[] {
    return this.documentChunker.chunkDocument(documentId, documentTitle, rawText);
  }

  formatChronology(entries: ChronologyEntry[], matterTitle?: string): string {
    return this.chronologyExtractor.formatToMarkdown(entries, matterTitle);
  }

  async draftCorrespondence(
    actorId: string,
    matterId: string,
    input: {
      title: string;
      instruction: string;
      contextDocuments?: Array<{ id: string; title: string; content: string }>;
    },
  ) {
    return this.generateDraft(actorId, matterId, {
      feature: 'draft_correspondence',
      draftType: 'correspondence_draft',
      title: input.title,
      instruction: input.instruction,
      contextDocuments: input.contextDocuments,
    });
  }

  async structureAttendanceNote(
    actorId: string,
    matterId: string,
    input: {
      title: string;
      rawNotes: string;
      feeEarnerName?: string;
      contextDocuments?: Array<{ id: string; title: string; content: string }>;
    },
  ) {
    const structured = this.attendanceNotes.structureRawNotes(input.rawNotes, {
      matterTitle: input.title,
      feeEarnerName: input.feeEarnerName,
    });
    const markdown = this.attendanceNotes.formatToMarkdown(structured);

    return this.generateDraft(actorId, matterId, {
      feature: 'draft_correspondence',
      draftType: 'correspondence_draft',
      title: `Attendance Note: ${input.title}`,
      instruction: `Structure, refine and professionalize the following raw attendance note:\n\n${markdown}`,
      contextDocuments: input.contextDocuments,
    });
  }

  async reviewDraft(
    actorId: string,
    matterId: string,
    draftId: string,
    input: ReviewDraftInput,
  ): Promise<{
    reviewId: string;
    promotedDocumentId?: string | null;
    promotedTaskId?: string | null;
  }> {
    await this.repository.assertMatterAccess(actorId, matterId);

    let docId = input.promotedToDocumentId ?? null;
    if (!docId && input.promoteToDocument && input.decision !== 'rejected') {
      docId = await this.repository.createPromotedDocument(
        matterId,
        actorId,
        input.promoteToDocument.title,
        input.promoteToDocument.category ?? 'correspondence',
      );
    }

    let taskId = input.promotedToTaskId ?? null;
    if (!taskId && input.promoteToTask && input.decision !== 'rejected') {
      taskId = await this.repository.createPromotedTask(
        matterId,
        actorId,
        input.promoteToTask.title,
        input.promoteToTask.description ?? null,
        input.promoteToTask.dueOn ?? null,
        input.promoteToTask.priority ?? 'normal',
        input.promoteToTask.assigneeId ?? actorId,
      );
    }

    const reviewId = await this.repository.recordReview(
      actorId,
      draftId,
      input.decision,
      input.finalText,
      input.feedbackReason,
      docId,
      taskId,
    );

    await this.audit.record({
      actor: { type: 'user', id: actorId },
      action: 'ai.draft_reviewed',
      outcome: 'success',
      resource: { type: 'matter', id: matterId },
      metadata: {
        draftId,
        reviewId,
        decision: input.decision,
        promotedToDocumentId: docId,
        promotedToTaskId: taskId,
      },
    });

    return {
      reviewId,
      promotedDocumentId: docId,
      promotedTaskId: taskId,
    };
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

  async getSupervisoryMetrics(): Promise<AiSupervisoryMetrics> {
    return this.repository.getAiMetrics();
  }

  async getMatterMetrics(actorId: string, matterId: string): Promise<MatterAiMetrics> {
    await this.repository.assertMatterAccess(actorId, matterId);
    return this.repository.getMatterMetrics(matterId);
  }
}
