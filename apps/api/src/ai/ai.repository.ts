import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, DocumentCategory, TaskPriority } from '../database/schema.js';
import type {
  AiFeature,
  AiDraftType,
  AiReviewDecision,
  AiSupervisoryMetrics,
  MatterAiMetrics,
  StructuredCitation,
} from './ai.types.js';

export interface AiConfigRecord {
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

export interface AiAuditRow {
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

@Injectable()
export class AiRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async readConfiguration(): Promise<AiConfigRecord | null> {
    const row = await this.db
      .selectFrom('ai_configurations')
      .selectAll()
      .where('id', '=', '00000000-0000-0000-0000-000000000001')
      .executeTakeFirst();

    if (!row) return null;

    return {
      id: row.id,
      provider: row.provider,
      modelName: row.model_name,
      endpointUrl: row.endpoint_url,
      maxTokensPerRequest: row.max_tokens_per_request,
      monthlyTokenBudget: row.monthly_token_budget,
      tokensUsedThisMonth: row.tokens_used_this_month,
      budgetResetOn: row.budget_reset_on instanceof Date ? row.budget_reset_on.toISOString().slice(0, 10) : String(row.budget_reset_on),
      enabled: row.enabled,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async updateConfiguration(
    actorId: string,
    provider: string,
    modelName: string,
    endpointUrl: string | null,
    maxTokens: number,
    monthlyBudget: number,
    enabled: boolean,
  ): Promise<void> {
    await sql`SELECT app.update_ai_configuration(
      ${actorId}::uuid,
      ${provider},
      ${modelName},
      ${endpointUrl},
      ${maxTokens}::integer,
      ${monthlyBudget}::integer,
      ${enabled}::boolean
    )`.execute(this.db);
  }

  async recordGeneration(
    actorId: string,
    matterId: string,
    feature: AiFeature,
    modelName: string,
    promptTokens: number,
    completionTokens: number,
    latencyMs: number,
    promptHash: Buffer,
    draftType: AiDraftType,
    title: string,
    generatedText: string,
    structuredCitations: StructuredCitation[],
    confidenceNotes?: string,
  ): Promise<{ requestId: string; draftId: string }> {
    const result = await sql<{ request_id: string; draft_id: string }>`
      SELECT * FROM app.record_ai_generation(
        ${actorId}::uuid,
        ${matterId}::uuid,
        ${feature},
        ${modelName},
        ${promptTokens}::integer,
        ${completionTokens}::integer,
        ${latencyMs}::integer,
        ${promptHash}::bytea,
        ${draftType},
        ${title},
        ${generatedText},
        ${JSON.stringify(structuredCitations)}::jsonb,
        ${confidenceNotes ?? null}
      )
    `.execute(this.db);

    const first = result.rows[0];
    if (!first) {
      throw new Error('Failed to record AI generation');
    }

    return {
      requestId: first.request_id,
      draftId: first.draft_id,
    };
  }

  async recordReview(
    actorId: string,
    draftId: string,
    decision: AiReviewDecision,
    finalText?: string | null,
    reason?: string | null,
    promotedDocId?: string | null,
    promotedTaskId?: string | null,
  ): Promise<string> {
    const result = await sql<{ record_ai_review: string }>`
      SELECT app.record_ai_review(
        ${actorId}::uuid,
        ${draftId}::uuid,
        ${decision},
        ${finalText ?? null},
        ${reason ?? null},
        ${promotedDocId ?? null}::uuid,
        ${promotedTaskId ?? null}::uuid
      )
    `.execute(this.db);

    const first = result.rows[0];
    if (!first) {
      throw new Error('Failed to record AI review');
    }

    return first.record_ai_review;
  }

  async createPromotedDocument(
    matterId: string,
    actorId: string,
    title: string,
    category: DocumentCategory = 'correspondence',
  ): Promise<string> {
    const result = await this.db
      .insertInto('documents')
      .values({
        matter_id: matterId,
        title,
        category,
        created_by: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return result.id;
  }

  async createPromotedTask(
    matterId: string,
    actorId: string,
    title: string,
    description: string | null = null,
    dueOn: string | null = null,
    priority: TaskPriority = 'normal',
    assignedTo?: string | null,
  ): Promise<string> {
    const result = await this.db
      .insertInto('tasks')
      .values({
        matter_id: matterId,
        title,
        description,
        due_on: dueOn,
        priority,
        assigned_to: assignedTo ?? actorId,
        created_by: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return result.id;
  }

  async assertMatterAccess(actorId: string, matterId: string): Promise<void> {
    await sql`SELECT app.assert_matter_ai_access(${actorId}::uuid, ${matterId}::uuid)`.execute(this.db);
  }

  async validateMatterDocumentOwnership(matterId: string, documentIds: string[]): Promise<boolean> {
    if (documentIds.length === 0) return true;
    const uniqueIds = Array.from(new Set(documentIds));
    const found = await this.db
      .selectFrom('documents')
      .select('id')
      .where('matter_id', '=', matterId)
      .where('id', 'in', uniqueIds)
      .execute();
    return found.length === uniqueIds.length;
  }

  async listMatterDrafts(actorId: string, matterId: string): Promise<AiDraftSummary[]> {
    await this.assertMatterAccess(actorId, matterId);

    const rows = await this.db
      .selectFrom('ai_drafts as d')
      .leftJoin('ai_reviews as r', 'r.draft_id', 'd.id')
      .select([
        'd.id',
        'd.request_id',
        'd.matter_id',
        'd.draft_type',
        'd.title',
        'd.created_at',
        'r.id as review_id',
        'r.decision as review_decision',
      ])
      .where('d.matter_id', '=', matterId)
      .orderBy('d.created_at', 'desc')
      .execute();

    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      matterId: r.matter_id,
      draftType: r.draft_type as AiDraftType,
      title: r.title,
      createdAt: r.created_at.toISOString(),
      reviewStatus: r.review_id ? 'reviewed' : 'pending',
      reviewDecision: (r.review_decision as AiReviewDecision) ?? null,
    }));
  }

  async readMatterDraft(actorId: string, matterId: string, draftId: string): Promise<AiDraftDetail | null> {
    await this.assertMatterAccess(actorId, matterId);

    const draft = await this.db
      .selectFrom('ai_drafts as d')
      .innerJoin('ai_requests as req', 'req.id', 'd.request_id')
      .leftJoin('ai_reviews as rev', 'rev.draft_id', 'd.id')
      .select([
        'd.id',
        'd.request_id',
        'd.matter_id',
        'd.draft_type',
        'd.title',
        'd.generated_text',
        'd.structured_citations',
        'd.confidence_notes',
        'd.created_at',
        'req.actor_id as req_actor_id',
        'req.feature as req_feature',
        'req.model_name as req_model_name',
        'req.prompt_tokens as req_prompt_tokens',
        'req.completion_tokens as req_completion_tokens',
        'req.latency_ms as req_latency_ms',
        'req.status as req_status',
        'rev.id as rev_id',
        'rev.reviewer_id as rev_reviewer_id',
        'rev.decision as rev_decision',
        'rev.final_text as rev_final_text',
        'rev.feedback_reason as rev_feedback_reason',
        'rev.promoted_to_document_id as rev_promoted_doc',
        'rev.promoted_to_task_id as rev_promoted_task',
        'rev.reviewed_at as rev_reviewed_at',
      ])
      .where('d.id', '=', draftId)
      .where('d.matter_id', '=', matterId)
      .executeTakeFirst();

    if (!draft) return null;

    let citations: StructuredCitation[] = [];
    if (Array.isArray(draft.structured_citations)) {
      citations = draft.structured_citations as StructuredCitation[];
    }

    return {
      id: draft.id,
      requestId: draft.request_id,
      matterId: draft.matter_id,
      draftType: draft.draft_type as AiDraftType,
      title: draft.title,
      generatedText: draft.generated_text,
      structuredCitations: citations,
      confidenceNotes: draft.confidence_notes,
      createdAt: draft.created_at.toISOString(),
      reviewStatus: draft.rev_id ? 'reviewed' : 'pending',
      reviewDecision: (draft.rev_decision as AiReviewDecision) ?? null,
      request: {
        actorId: draft.req_actor_id,
        feature: draft.req_feature as AiFeature,
        modelName: draft.req_model_name,
        promptTokens: draft.req_prompt_tokens,
        completionTokens: draft.req_completion_tokens,
        latencyMs: draft.req_latency_ms,
        status: draft.req_status,
      },
      review: draft.rev_id
        ? {
            reviewerId: draft.rev_reviewer_id!,
            decision: draft.rev_decision as AiReviewDecision,
            finalText: draft.rev_final_text,
            feedbackReason: draft.rev_feedback_reason,
            promotedToDocumentId: draft.rev_promoted_doc,
            promotedToTaskId: draft.rev_promoted_task,
            reviewedAt: draft.rev_reviewed_at!.toISOString(),
          }
        : null,
    };
  }

  async listAuditEvents(limit = 100): Promise<AiAuditRow[]> {
    const rows = await this.db
      .selectFrom('ai_requests as req')
      .innerJoin('accounts as a', 'a.id', 'req.actor_id')
      .innerJoin('matters as m', 'm.id', 'req.matter_id')
      .select([
        'req.id',
        'req.actor_id',
        'a.display_name as actor_name',
        'req.matter_id',
        'm.title as matter_title',
        'req.feature',
        'req.model_name',
        'req.prompt_tokens',
        'req.completion_tokens',
        'req.latency_ms',
        'req.status',
        'req.created_at',
      ])
      .orderBy('req.created_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      matterId: r.matter_id,
      matterTitle: r.matter_title,
      feature: r.feature,
      modelName: r.model_name,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      latencyMs: r.latency_ms,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async getMatterTokenUsageThisMonth(matterId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const row = await this.db
      .selectFrom('ai_requests')
      .select(sql<string>`COALESCE(SUM(prompt_tokens + completion_tokens), 0)`.as('total'))
      .where('matter_id', '=', matterId)
      .where('created_at', '>=', startOfMonth)
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  }

  async getAiMetrics(): Promise<AiSupervisoryMetrics> {
    const cfg = await this.readConfiguration();

    const totalRequestsRow = await this.db
      .selectFrom('ai_requests')
      .select(sql<string>`COUNT(*)`.as('total'))
      .executeTakeFirst();

    const featuresRows = await this.db
      .selectFrom('ai_requests')
      .select(['feature', sql<string>`COUNT(*)`.as('cnt')])
      .groupBy('feature')
      .execute();

    const requestsByFeature: Record<string, number> = {};
    for (const f of featuresRows) {
      requestsByFeature[f.feature] = Number(f.cnt);
    }

    const reviewsRows = await this.db
      .selectFrom('ai_reviews')
      .select(['decision', sql<string>`COUNT(*)`.as('cnt')])
      .groupBy('decision')
      .execute();

    const reviewDecisions = {
      accepted: 0,
      modified: 0,
      rejected: 0,
      pending: 0,
    };
    for (const r of reviewsRows) {
      if (r.decision === 'accepted') reviewDecisions.accepted = Number(r.cnt);
      else if (r.decision === 'modified') reviewDecisions.modified = Number(r.cnt);
      else if (r.decision === 'rejected') reviewDecisions.rejected = Number(r.cnt);
    }

    const pendingDraftsRow = await this.db
      .selectFrom('ai_drafts as d')
      .leftJoin('ai_reviews as r', 'r.draft_id', 'd.id')
      .where('r.id', 'is', null)
      .select(sql<string>`COUNT(*)`.as('cnt'))
      .executeTakeFirst();
    reviewDecisions.pending = Number(pendingDraftsRow?.cnt ?? 0);

    const topMatters = await this.db
      .selectFrom('ai_requests as req')
      .innerJoin('matters as m', 'm.id', 'req.matter_id')
      .select([
        'req.matter_id',
        'm.title as matter_title',
        sql<string>`SUM(req.prompt_tokens + req.completion_tokens)`.as('total_tokens'),
        sql<string>`COUNT(*)`.as('req_count'),
      ])
      .groupBy(['req.matter_id', 'm.title'])
      .orderBy(sql`total_tokens`, 'desc')
      .limit(5)
      .execute();

    const topMattersUsage = topMatters.map((tm) => ({
      matterId: tm.matter_id,
      matterTitle: tm.matter_title,
      totalTokens: Number(tm.total_tokens || 0),
      requestCount: Number(tm.req_count || 0),
    }));

    return {
      monthlyBudget: {
        monthlyTokenBudget: cfg?.monthlyTokenBudget ?? 500000,
        tokensUsedThisMonth: cfg?.tokensUsedThisMonth ?? 0,
        budgetResetOn: cfg?.budgetResetOn ?? new Date().toISOString().slice(0, 10),
        percentUsed: cfg?.monthlyTokenBudget
          ? Math.round((cfg.tokensUsedThisMonth / cfg.monthlyTokenBudget) * 100)
          : 0,
      },
      totalRequestsCount: Number(totalRequestsRow?.total ?? 0),
      requestsByFeature,
      reviewDecisions,
      securityAndCompliance: {
        injectionsDetectedCount: 0,
        unverifiedCitationsCount: 0,
      },
      topMattersUsage,
    };
  }

  async getMatterMetrics(matterId: string, matterAllowance = 100000): Promise<MatterAiMetrics> {
    const tokensUsedThisMonth = await this.getMatterTokenUsageThisMonth(matterId);

    const requestsRow = await this.db
      .selectFrom('ai_requests')
      .where('matter_id', '=', matterId)
      .select(sql<string>`COUNT(*)`.as('cnt'))
      .executeTakeFirst();

    const draftsRow = await this.db
      .selectFrom('ai_drafts')
      .where('matter_id', '=', matterId)
      .select(sql<string>`COUNT(*)`.as('cnt'))
      .executeTakeFirst();

    const pendingRow = await this.db
      .selectFrom('ai_drafts as d')
      .leftJoin('ai_reviews as r', 'r.draft_id', 'd.id')
      .where('d.matter_id', '=', matterId)
      .where('r.id', 'is', null)
      .select(sql<string>`COUNT(*)`.as('cnt'))
      .executeTakeFirst();

    return {
      matterId,
      tokensUsedThisMonth,
      matterTokenAllowance: matterAllowance,
      percentUsed: Math.min(100, Math.round((tokensUsedThisMonth / matterAllowance) * 100)),
      totalRequests: Number(requestsRow?.cnt ?? 0),
      totalDrafts: Number(draftsRow?.cnt ?? 0),
      pendingReviews: Number(pendingRow?.cnt ?? 0),
    };
  }
}
