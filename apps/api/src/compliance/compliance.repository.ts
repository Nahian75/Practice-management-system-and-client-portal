import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { AmlControlKind, AmlOfficerKind, Database } from '../database/schema.js';
import type { ControlVersion, IndependentReview, OfficerAppointment, TrainingCompletion } from './compliance.js';

@Injectable()
export class ComplianceRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async appoint(accountId: string, kind: AmlOfficerKind, actorId: string, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.appoint_aml_officer(${accountId}, ${kind}, ${actorId}) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async endAppointment(id: string, reason: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.end_aml_officer_appointment(${id}, ${reason}, ${actorId})`.execute(trx);
  }

  async findAppointment(id: string, executor: Kysely<Database> = this.db): Promise<OfficerAppointment | undefined> {
    const row = await executor.selectFrom('aml_officer_appointments as o')
      .innerJoin('accounts as target', 'target.id', 'o.account_id')
      .innerJoin('accounts as appointing', 'appointing.id', 'o.appointed_by')
      .leftJoin('accounts as ending', 'ending.id', 'o.ended_by')
      .select(['o.id', 'o.kind', 'o.appointed_at', 'o.ended_at', 'o.end_reason',
        'target.id as account_id', 'target.display_name as account_name',
        'appointing.id as appointed_by_id', 'appointing.display_name as appointed_by_name',
        'ending.id as ended_by_id', 'ending.display_name as ended_by_name'])
      .where('o.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, kind: row.kind,
      account: { accountId: row.account_id, displayName: row.account_name },
      appointedBy: { accountId: row.appointed_by_id, displayName: row.appointed_by_name },
      appointedAt: row.appointed_at, endedAt: row.ended_at, endReason: row.end_reason,
      endedBy: row.ended_by_id && row.ended_by_name
        ? { accountId: row.ended_by_id, displayName: row.ended_by_name } : null,
    };
  }

  async listAppointments(before?: string): Promise<OfficerAppointment[]> {
    let query = this.db.selectFrom('aml_officer_appointments').select('id');
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findAppointment(row.id))))
      .filter((row): row is OfficerAppointment => row !== undefined);
  }

  async createControl(input: {
    kind: AmlControlKind; title: string; content: string; hash: Buffer; source: string;
    effectiveFrom: string; reviewDueOn: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_aml_control_version(
      ${input.kind}, ${input.title}, ${input.content}, ${input.hash}, ${input.source},
      ${input.effectiveFrom}::date, ${input.reviewDueOn}::date, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async approveControl(id: string, actorId: string, trx: Kysely<Database>): Promise<void> {
    await sql`select app.approve_aml_control_version(${id}, ${actorId})`.execute(trx);
  }

  async findControl(id: string, executor: Kysely<Database> = this.db): Promise<ControlVersion | undefined> {
    const row = await executor.selectFrom('aml_control_versions as v')
      .innerJoin('accounts as preparer', 'preparer.id', 'v.prepared_by')
      .leftJoin('aml_control_approvals as p', 'p.control_version_id', 'v.id')
      .leftJoin('accounts as approver', 'approver.id', 'p.approved_by')
      .select(['v.id', 'v.kind', 'v.version', 'v.title', 'v.content', 'v.content_sha256', 'v.source',
        'v.effective_from', 'v.review_due_on', 'v.prepared_at', 'preparer.id as prepared_by_id',
        'preparer.display_name as prepared_by_name', 'p.id as approval_id', 'p.approved_at',
        'approver.id as approved_by_id', 'approver.display_name as approved_by_name'])
      .where('v.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, kind: row.kind, version: row.version, title: row.title, content: row.content,
      contentSha256: row.content_sha256.toString('hex'), source: row.source,
      effectiveFrom: row.effective_from, reviewDueOn: row.review_due_on,
      preparedBy: { accountId: row.prepared_by_id, displayName: row.prepared_by_name }, preparedAt: row.prepared_at,
      approval: row.approval_id && row.approved_at && row.approved_by_id && row.approved_by_name
        ? { id: row.approval_id, approvedAt: row.approved_at,
            approvedBy: { accountId: row.approved_by_id, displayName: row.approved_by_name } } : null,
    };
  }

  async listControls(pendingOnly = false, before?: string): Promise<ControlVersion[]> {
    let query = this.db.selectFrom('aml_control_versions as v').leftJoin('aml_control_approvals as p', 'p.control_version_id', 'v.id').select('v.id');
    if (pendingOnly) query = query.where('p.id', 'is', null);
    if (before) query = query.where('v.id', '<', before);
    const rows = await query.orderBy('v.id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findControl(row.id))))
      .filter((row): row is ControlVersion => row !== undefined);
  }

  async recordTraining(input: {
    accountId: string; materialId: string; provider: string; completedOn: string;
    evidenceReference: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_aml_training(
      ${input.accountId}, ${input.materialId}, ${input.provider}, ${input.completedOn}::date,
      ${input.evidenceReference}, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findTraining(id: string, executor: Kysely<Database> = this.db): Promise<TrainingCompletion | undefined> {
    const row = await executor.selectFrom('aml_training_completions as t')
      .innerJoin('accounts as subject', 'subject.id', 't.account_id')
      .innerJoin('accounts as recorder', 'recorder.id', 't.recorded_by')
      .innerJoin('aml_control_versions as material', 'material.id', 't.training_material_id')
      .select(['t.id', 't.provider', 't.completed_on', 't.evidence_reference', 't.recorded_at',
        'subject.id as account_id', 'subject.display_name as account_name',
        'recorder.id as recorded_by_id', 'recorder.display_name as recorded_by_name',
        'material.id as material_id', 'material.version as material_version', 'material.title as material_title'])
      .where('t.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, account: { accountId: row.account_id, displayName: row.account_name },
      material: { id: row.material_id, version: row.material_version, title: row.material_title },
      provider: row.provider, completedOn: row.completed_on, evidenceReference: row.evidence_reference,
      recordedBy: { accountId: row.recorded_by_id, displayName: row.recorded_by_name }, recordedAt: row.recorded_at,
    };
  }

  async listTraining(accountId?: string, before?: string): Promise<TrainingCompletion[]> {
    let query = this.db.selectFrom('aml_training_completions').select('id');
    if (accountId) query = query.where('account_id', '=', accountId);
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findTraining(row.id))))
      .filter((row): row is TrainingCompletion => row !== undefined);
  }

  async recordReview(input: {
    periodStart: string; periodEnd: string; completedOn: string; reviewerName: string;
    reviewerOrganisation: string | null; independenceBasis: string; scope: string;
    findings: string; recommendations: string; managementResponse: string; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_aml_independent_review(
      ${input.periodStart}::date, ${input.periodEnd}::date, ${input.completedOn}::date,
      ${input.reviewerName}, ${input.reviewerOrganisation}, ${input.independenceBasis}, ${input.scope},
      ${input.findings}, ${input.recommendations}, ${input.managementResponse}, ${input.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async findReview(id: string, executor: Kysely<Database> = this.db): Promise<IndependentReview | undefined> {
    const row = await executor.selectFrom('aml_independent_reviews as r')
      .innerJoin('accounts as recorder', 'recorder.id', 'r.recorded_by')
      .select(['r.id', 'r.period_start', 'r.period_end', 'r.completed_on', 'r.reviewer_name',
        'r.reviewer_organisation', 'r.independence_basis', 'r.scope', 'r.findings', 'r.recommendations',
        'r.management_response', 'r.recorded_at', 'recorder.id as recorded_by_id',
        'recorder.display_name as recorded_by_name']).where('r.id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    return {
      id: row.id, periodStart: row.period_start, periodEnd: row.period_end, completedOn: row.completed_on,
      reviewerName: row.reviewer_name, reviewerOrganisation: row.reviewer_organisation,
      independenceBasis: row.independence_basis, scope: row.scope, findings: row.findings,
      recommendations: row.recommendations, managementResponse: row.management_response,
      recordedBy: { accountId: row.recorded_by_id, displayName: row.recorded_by_name }, recordedAt: row.recorded_at,
    };
  }

  async listReviews(before?: string): Promise<IndependentReview[]> {
    let query = this.db.selectFrom('aml_independent_reviews').select('id');
    if (before) query = query.where('id', '<', before);
    const rows = await query.orderBy('id', 'desc').limit(100).execute();
    return (await Promise.all(rows.map((row) => this.findReview(row.id))))
      .filter((row): row is IndependentReview => row !== undefined);
  }
}
