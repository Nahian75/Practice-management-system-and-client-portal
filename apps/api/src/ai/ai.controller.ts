import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import {
  AI_DRAFT_TYPES,
  AI_FEATURES,
  AI_REVIEW_DECISIONS,
} from './ai.types.js';
import { AiService } from './ai.service.js';

const configSchema = z.strictObject({
  provider: z.enum(['offline_mock', 'azure_openai', 'aws_bedrock', 'custom']),
  modelName: text(100),
  endpointUrl: z.url().nullable().optional(),
  maxTokensPerRequest: z.number().int().min(100).max(32768),
  monthlyTokenBudget: z.number().int().min(1000),
  enabled: z.boolean(),
});

const configResponseSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  modelName: z.string(),
  endpointUrl: z.string().nullable(),
  maxTokensPerRequest: z.number(),
  monthlyTokenBudget: z.number(),
  tokensUsedThisMonth: z.number(),
  budgetResetOn: z.string(),
  enabled: z.boolean(),
  updatedAt: z.string(),
});

const citationSchema = z.object({
  sourceDocumentId: z.string(),
  documentTitle: z.string(),
  pageNumber: z.number().optional(),
  quote: z.string(),
});

const generateInputSchema = z.strictObject({
  feature: z.enum(AI_FEATURES),
  draftType: z.enum(AI_DRAFT_TYPES),
  title: text(200),
  instruction: text(4000),
  contextDocuments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: text(200),
        content: z.string().max(50000),
      }),
    )
    .optional(),
});

const semanticFeatureInputSchema = z.strictObject({
  title: text(200),
  instruction: text(4000),
  contextDocuments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: text(200),
        content: z.string().max(50000),
      }),
    )
    .optional(),
});

const attendanceNoteInputSchema = z.strictObject({
  title: text(200),
  rawNotes: z.string().min(1).max(50000),
  feeEarnerName: text(100).optional(),
  contextDocuments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: text(200),
        content: z.string().max(50000),
      }),
    )
    .optional(),
});

const generateResponseSchema = z.object({
  requestId: z.uuid(),
  draftId: z.uuid(),
  generatedText: z.string(),
  structuredCitations: z.array(citationSchema),
  confidenceNotes: z.string().optional(),
});

const draftSummarySchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  matterId: z.uuid(),
  draftType: z.enum(AI_DRAFT_TYPES),
  title: z.string(),
  createdAt: z.string(),
  reviewStatus: z.enum(['pending', 'reviewed']),
  reviewDecision: z.enum(AI_REVIEW_DECISIONS).nullable(),
});

const draftListResponseSchema = z.object({
  drafts: z.array(draftSummarySchema),
});

const draftDetailResponseSchema = draftSummarySchema.extend({
  generatedText: z.string(),
  structuredCitations: z.array(citationSchema),
  confidenceNotes: z.string().nullable(),
  request: z.object({
    actorId: z.uuid(),
    feature: z.enum(AI_FEATURES),
    modelName: z.string(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    latencyMs: z.number(),
    status: z.string(),
  }),
  review: z
    .object({
      reviewerId: z.uuid(),
      decision: z.enum(AI_REVIEW_DECISIONS),
      finalText: z.string().nullable(),
      feedbackReason: z.string().nullable(),
      promotedToDocumentId: z.uuid().nullable(),
      promotedToTaskId: z.uuid().nullable(),
      reviewedAt: z.string(),
    })
    .nullable(),
});

const reviewInputSchema = z.strictObject({
  decision: z.enum(AI_REVIEW_DECISIONS),
  finalText: z.string().max(100000).nullable().optional(),
  feedbackReason: text(1000).nullable().optional(),
  promotedToDocumentId: z.uuid().nullable().optional(),
  promotedToTaskId: z.uuid().nullable().optional(),
  promoteToDocument: z
    .strictObject({
      title: text(200),
      category: z.enum(['correspondence', 'contract', 'evidence', 'identity', 'court', 'other']).optional(),
    })
    .nullable()
    .optional(),
  promoteToTask: z
    .strictObject({
      title: text(200),
      description: text(2000).nullable().optional(),
      dueOn: z.string().nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assigneeId: z.uuid().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const reviewResponseSchema = z.object({
  reviewId: z.uuid(),
  promotedDocumentId: z.uuid().nullable().optional(),
  promotedTaskId: z.uuid().nullable().optional(),
});

const auditEventSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid(),
  actorName: z.string(),
  matterId: z.uuid(),
  matterTitle: z.string(),
  feature: z.string(),
  modelName: z.string(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  latencyMs: z.number(),
  status: z.string(),
  createdAt: z.string(),
});

const auditListResponseSchema = z.object({
  events: z.array(auditEventSchema),
});

const supervisoryMetricsResponseSchema = z.object({
  monthlyBudget: z.object({
    monthlyTokenBudget: z.number(),
    tokensUsedThisMonth: z.number(),
    budgetResetOn: z.string(),
    percentUsed: z.number(),
  }),
  totalRequestsCount: z.number(),
  requestsByFeature: z.record(z.string(), z.number()),
  reviewDecisions: z.object({
    accepted: z.number(),
    modified: z.number(),
    rejected: z.number(),
    pending: z.number(),
  }),
  securityAndCompliance: z.object({
    injectionsDetectedCount: z.number(),
    unverifiedCitationsCount: z.number(),
  }),
  topMattersUsage: z.array(
    z.object({
      matterId: z.uuid(),
      matterTitle: z.string(),
      totalTokens: z.number(),
      requestCount: z.number(),
    }),
  ),
});

const matterMetricsResponseSchema = z.object({
  matterId: z.uuid(),
  tokensUsedThisMonth: z.number(),
  matterTokenAllowance: z.number(),
  percentUsed: z.number(),
  totalRequests: z.number(),
  totalDrafts: z.number(),
  pendingReviews: z.number(),
});

@Controller()
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('ai/config')
  @RequirePermission('ai.manage_config')
  @ResponseSchema(configResponseSchema)
  async getConfig() {
    return this.aiService.readConfiguration();
  }

  @Put('ai/config')
  @RequirePermission('ai.manage_config')
  @ResponseSchema(configResponseSchema)
  async updateConfig(
    @Body({ schema: configSchema }) body: z.infer<typeof configSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.updateConfiguration(session.account.id, body);
  }

  @Post('matters/:matterId/ai/generate')
  @RequirePermission('ai.use')
  @ResponseSchema(generateResponseSchema)
  async generate(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: generateInputSchema }) body: z.infer<typeof generateInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.generateDraft(session.account.id, matterId, body);
  }

  @Post('matters/:matterId/ai/summarise-document')
  @RequirePermission('ai.use')
  @ResponseSchema(generateResponseSchema)
  async summariseDocument(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: semanticFeatureInputSchema }) body: z.infer<typeof semanticFeatureInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.summariseDocument(session.account.id, matterId, body);
  }

  @Post('matters/:matterId/ai/extract-chronology')
  @RequirePermission('ai.use')
  @ResponseSchema(generateResponseSchema)
  async extractChronology(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: semanticFeatureInputSchema }) body: z.infer<typeof semanticFeatureInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.extractChronology(session.account.id, matterId, body);
  }

  @Post('matters/:matterId/ai/draft-correspondence')
  @RequirePermission('ai.use')
  @ResponseSchema(generateResponseSchema)
  async draftCorrespondence(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: semanticFeatureInputSchema }) body: z.infer<typeof semanticFeatureInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.draftCorrespondence(session.account.id, matterId, body);
  }

  @Post('matters/:matterId/ai/structure-attendance-note')
  @RequirePermission('ai.use')
  @ResponseSchema(generateResponseSchema)
  async structureAttendanceNote(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: attendanceNoteInputSchema }) body: z.infer<typeof attendanceNoteInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.structureAttendanceNote(session.account.id, matterId, body);
  }

  @Get('matters/:matterId/ai/drafts')
  @RequirePermission('ai.use')
  @ResponseSchema(draftListResponseSchema)
  async listDrafts(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    const drafts = await this.aiService.listMatterDrafts(session.account.id, matterId);
    return { drafts };
  }

  @Get('matters/:matterId/ai/drafts/:draftId')
  @RequirePermission('ai.use')
  @ResponseSchema(draftDetailResponseSchema)
  async getDraft(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('draftId', { schema: z.uuid() }) draftId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.readMatterDraft(session.account.id, matterId, draftId);
  }

  @Post('matters/:matterId/ai/drafts/:draftId/review')
  @RequirePermission('ai.use')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(reviewResponseSchema)
  async review(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('draftId', { schema: z.uuid() }) draftId: string,
    @Body({ schema: reviewInputSchema }) body: z.infer<typeof reviewInputSchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.reviewDraft(session.account.id, matterId, draftId, body);
  }

  @Get('ai/audit')
  @RequirePermission('ai.audit')
  @ResponseSchema(auditListResponseSchema)
  async getAudit(@Query('limit') limitStr?: string) {
    const limit = limitStr ? Math.min(Number(limitStr) || 100, 500) : 100;
    const events = await this.aiService.listAuditEvents(limit);
    return { events };
  }

  @Get('ai/metrics')
  @RequirePermission('ai.audit')
  @ResponseSchema(supervisoryMetricsResponseSchema)
  async getSupervisoryMetrics() {
    return this.aiService.getSupervisoryMetrics();
  }

  @Get('matters/:matterId/ai/metrics')
  @RequirePermission('ai.use')
  @ResponseSchema(matterMetricsResponseSchema)
  async getMatterMetrics(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @CurrentSession() session: ResolvedSession,
  ) {
    return this.aiService.getMatterMetrics(session.account.id, matterId);
  }
}
