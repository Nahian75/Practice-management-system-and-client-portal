import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActor } from '../audit/audit-event.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { AmlControlKind, AmlOfficerKind } from '../database/schema.js';
import type { ControlVersion, IndependentReview, OfficerAppointment, TrainingCompletion } from './compliance.js';
import { ComplianceRepository } from './compliance.repository.js';

export interface ComplianceActor { actor: AuditActor; accountId: string; context?: RequestContext }
export type Change<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' } | { outcome: 'conflict' };
const COMPLIANCE_PAGE_SIZE = 100;

function page<T extends { id: string }>(items: T[]): { items: T[]; next: string | null } {
  return { items, next: items.length === COMPLIANCE_PAGE_SIZE ? items.at(-1)!.id : null };
}

@Injectable()
export class ComplianceService {
  constructor(private readonly records: ComplianceRepository, private readonly audit: AuditService) {}

  async listAppointments(before?: string) { return page(await this.records.listAppointments(before)); }

  async appoint(accountId: string, kind: AmlOfficerKind, by: ComplianceActor): Promise<Change<OfficerAppointment>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.appoint(accountId, kind, by.accountId, trx);
        const appointment = await this.records.findAppointment(id, trx);
        if (!appointment) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.officer_appointed', outcome: 'success',
          resource: { type: 'aml_officer_appointment', id }, metadata: { accountId, kind }, ...by.context }, trx);
        return appointment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async endAppointment(id: string, reason: string, by: ComplianceActor): Promise<Change<OfficerAppointment>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.endAppointment(id, reason, by.accountId, trx);
        const appointment = await this.records.findAppointment(id, trx);
        if (!appointment) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.officer_appointment_ended', outcome: 'success',
          resource: { type: 'aml_officer_appointment', id }, metadata: { kind: appointment.kind }, ...by.context }, trx);
        return appointment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listControls(pendingOnly = false, before?: string) { return page(await this.records.listControls(pendingOnly, before)); }
  findControl(id: string) { return this.records.findControl(id); }

  async createControl(input: {
    kind: AmlControlKind; title: string; content: string; source: string;
    effectiveFrom: string; reviewDueOn: string;
  }, by: ComplianceActor): Promise<Change<ControlVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const hash = createHash('sha256').update(input.content, 'utf8').digest();
        const id = await this.records.createControl({ ...input, hash, actorId: by.accountId }, trx);
        const control = await this.records.findControl(id, trx);
        if (!control) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.control_published', outcome: 'success',
          resource: { type: 'aml_control_version', id }, metadata: { kind: control.kind, version: control.version }, ...by.context }, trx);
        return control;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async approveControl(id: string, by: ComplianceActor): Promise<Change<ControlVersion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        await this.records.approveControl(id, by.accountId, trx);
        const control = await this.records.findControl(id, trx);
        if (!control) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.control_approved', outcome: 'success',
          resource: { type: 'aml_control_version', id }, metadata: { kind: control.kind, version: control.version }, ...by.context }, trx);
        return control;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'not_found' };
    } catch (error) { return databaseOutcome(error); }
  }

  async recordTraining(input: {
    accountId: string; materialId: string; provider: string; completedOn: string; evidenceReference: string;
  }, by: ComplianceActor): Promise<Change<TrainingCompletion>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.recordTraining({ ...input, actorId: by.accountId }, trx);
        const completion = await this.records.findTraining(id, trx);
        if (!completion) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.training_recorded', outcome: 'success',
          resource: { type: 'aml_training_completion', id },
          metadata: { accountId: input.accountId, materialId: input.materialId }, ...by.context }, trx);
        return completion;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listTraining(accountId?: string, before?: string) { return page(await this.records.listTraining(accountId, before)); }

  async recordReview(input: {
    periodStart: string; periodEnd: string; completedOn: string; reviewerName: string;
    reviewerOrganisation: string | null; independenceBasis: string; scope: string;
    findings: string; recommendations: string; managementResponse: string;
  }, by: ComplianceActor): Promise<Change<IndependentReview>> {
    try {
      const value = await this.records.transaction(async (trx) => {
        const id = await this.records.recordReview({ ...input, actorId: by.accountId }, trx);
        const review = await this.records.findReview(id, trx);
        if (!review) return undefined;
        await this.audit.record({ actor: by.actor, action: 'aml.independent_review_recorded', outcome: 'success',
          resource: { type: 'aml_independent_review', id },
          metadata: { periodStart: input.periodStart, periodEnd: input.periodEnd }, ...by.context }, trx);
        return review;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) { return databaseOutcome(error); }
  }

  async listReviews(before?: string) { return page(await this.records.listReviews(before)); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function databaseOutcome<T>(error: unknown): Change<T> {
  if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
  if (['23505', '23514', '42501', '22P02', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
  throw error;
}
