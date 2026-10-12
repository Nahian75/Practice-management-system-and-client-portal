import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { HrEntitlementKind, HrFitnessStatus, HrLeaveKind } from '../database/schema.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrLeaveRepository, type AdjustmentRow, type LeaveRequestRow, type SealedRow } from './hr-leave.repository.js';
import type { HrActor } from './hr.service.js';

export type HrLeaveChange<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };

@Injectable()
export class HrLeaveService {
  constructor(private readonly records: HrLeaveRepository, private readonly cipher: HrDataCipher,
    private readonly audit: AuditService) {}

  async policies(actorId: string) {
    return (await this.records.policies(actorId)).map((row) => ({ id: row.id, version: row.version,
      effectiveFrom: row.effective_from, leaveYearMonth: row.leave_year_month, leaveYearDay: row.leave_year_day,
      standardEntitlementMinutes: row.standard_entitlement_minutes,
      carryOverLimitMinutes: row.carry_over_limit_minutes, bookingNoticeDays: row.booking_notice_days,
      annualApprovalRoute: row.annual_approval_route, recordedBy: row.recorded_by, recordedAt: row.recorded_at }));
  }

  createPolicy(input: { effectiveFrom: string; leaveYearMonth: number; leaveYearDay: number;
    standardEntitlementMinutes: number; carryOverLimitMinutes: number; bookingNoticeDays: number;
    annualApprovalRoute: 'manager_or_hr' | 'hr_only' }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.createPolicy({ ...input, actorId: by.accountId }, trx);
      await this.log('hr.leave_policy_created', 'hr_leave_policy', id, { effectiveFrom: input.effectiveFrom }, by, trx);
      return { id };
    }));
  }

  recordEntitlement(personId: string, input: { leaveYearStart: string; kind: Exclude<HrEntitlementKind,
    'consumption' | 'cancellation_return'>; minutes: number; reason: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordEntitlement({ id, personId, leaveYearStart: input.leaveYearStart,
        kind: input.kind, minutes: input.minutes, sealed: this.cipher.seal({ reason: input.reason },
          `hr-leave-entitlement:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.leave_entitlement_recorded', 'hr_leave_entitlement', id,
        { personId, kind: input.kind, minutes: input.minutes }, by, trx);
      return { id };
    }));
  }

  createRequest(personId: string, input: { kind: HrLeaveKind; startsOn: string; endsOn: string; reason: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createRequest({ id, personId, kind: input.kind, startsOn: input.startsOn,
        endsOn: input.endsOn, sealed: this.cipher.seal({ reason: input.reason }, `hr-leave-request:${id}`),
        actorId: by.accountId }, trx);
      await this.log('hr.leave_requested', 'hr_leave_request', id,
        { personId, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn }, by, trx);
      return { id };
    }));
  }

  decideRequest(requestId: string, input: { action: 'approved' | 'refused'; reason: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const eventId = await this.records.newId(trx), entitlementId = await this.records.newId(trx);
      const minutes = await this.records.decideRequest({ eventId, requestId, action: input.action,
        event: this.cipher.seal({ reason: input.reason }, `hr-leave-event:${eventId}`), entitlementId,
        entitlement: this.cipher.seal({ source: 'approved_leave' }, `hr-leave-entitlement:${entitlementId}`),
        actorId: by.accountId }, trx);
      await this.log(`hr.leave_${input.action}`, 'hr_leave_request', requestId, { minutes }, by, trx);
      return { id: requestId, minutes };
    }));
  }

  cancelRequest(requestId: string, input: { reason: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const eventId = await this.records.newId(trx), entitlementId = await this.records.newId(trx);
      const minutes = await this.records.cancelRequest({ eventId, requestId,
        event: this.cipher.seal({ reason: input.reason }, `hr-leave-event:${eventId}`), entitlementId,
        entitlement: this.cipher.seal({ source: 'leave_cancellation' }, `hr-leave-entitlement:${entitlementId}`),
        actorId: by.accountId }, trx);
      await this.log('hr.leave_cancelled', 'hr_leave_request', requestId, { minutesReturned: minutes }, by, trx);
      return { id: requestId, minutesReturned: minutes };
    }));
  }

  async leave(personId: string, actorId: string, managerProjection = false) {
    try {
      const [requests, entitlement, sickness] = await Promise.all([
        this.records.requests(personId, actorId), this.records.entitlement(personId, actorId),
        this.records.sickness(personId, actorId),
      ]);
      const pay = managerProjection ? [] : await this.records.holidayPay(personId, actorId);
      return { requests: requests.map((row) => this.mapRequest(row)),
        balanceMinutes: entitlement.reduce((sum, row) => sum + row.minutes, 0),
        entitlement: managerProjection ? [] : entitlement.map((row) => ({ id: row.id,
          leaveYearStart: row.leave_year_start, kind: row.kind, minutes: row.minutes,
          leaveRequestId: row.leave_request_id,
          reason: (() => { const value = this.open<{ reason?: string; source?: string }>(row);
            return value.reason ?? value.source ?? ''; })(),
          recordedBy: row.recorded_by, recordedAt: row.recorded_at })),
        holidayPay: pay.map((row) => ({ id: row.id, leaveRequestId: row.leave_request_id,
          periodStartsOn: row.period_starts_on, periodEndsOn: row.period_ends_on,
          amountPence: Number(row.amount_pence), basis: row.basis, includedElements: row.included_elements,
          retentionUntil: row.retention_until, recordedBy: row.recorded_by, recordedAt: row.recorded_at })),
        sickness: sickness.map((row) => ({ id: row.id, startedOn: row.started_on, endedOn: row.ended_on,
          notifiedAt: row.notified_at, fitnessStatus: row.fitness_status, recordedBy: row.recorded_by,
          recordedAt: row.recorded_at })) };
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  async pendingRequests(actorId: string) {
    return (await this.records.pendingRequests(actorId)).map((row) => ({ ...this.mapRequest(row),
      accountId: row.account_id!, displayName: row.display_name! }));
  }

  recordHolidayPay(personId: string, input: { requestId: string; periodStartsOn: string; periodEndsOn: string;
    amountPence: number; basis: 'normal' | 'basic' | 'rolled_up' | 'other';
    includedElements: Array<{ name: string; amountPence: number }> }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.recordHolidayPay({ personId, ...input, actorId: by.accountId }, trx);
      await this.log('hr.holiday_pay_recorded', 'hr_holiday_pay', id,
        { personId, requestId: input.requestId, amountPence: input.amountPence }, by, trx);
      return { id };
    }));
  }

  recordSickness(personId: string, input: { startedOn: string; endedOn: string | null;
    notifiedAt: string; fitnessStatus: HrFitnessStatus }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.recordSickness({ personId, ...input, actorId: by.accountId }, trx);
      await this.log('hr.sickness_recorded', 'hr_sickness_absence', id,
        { personId, startedOn: input.startedOn, endedOn: input.endedOn ?? '' }, by, trx);
      return { id };
    }));
  }

  async health(personId: string, by: HrActor) {
    try {
      const rows = await this.records.health(personId, by.accountId);
      await this.log('hr.health_viewed', 'hr_person', personId, {}, by);
      return rows.map((row) => ({ id: row.id, kind: row.kind, validFrom: row.valid_from,
        validTo: row.valid_to, details: this.open<{ details: string }>(row).details, recordedBy: row.recorded_by,
        recordedAt: row.recorded_at }));
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  recordHealth(personId: string, input: { kind: 'sickness_detail' | 'fit_note' | 'occupational_health' | 'adjustment_ground';
    validFrom: string | null; validTo: string | null; details: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordHealth({ id, personId, ...input,
        sealed: this.cipher.seal({ details: input.details }, `hr-health:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.health_recorded', 'hr_health_record', id, { personId, kind: input.kind }, by, trx);
      return { id };
    }));
  }

  createAdjustment(personId: string, input: { request: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createAdjustment({ id, personId,
        sealed: this.cipher.seal({ request: input.request }, `hr-adjustment-request:${id}`),
        actorId: by.accountId }, trx);
      await this.log('hr.adjustment_requested', 'hr_adjustment_request', id, { personId }, by, trx);
      return { id };
    }));
  }

  decideAdjustment(requestId: string, input: { outcome: 'agreed' | 'refused'; reason: string;
    operationalInstruction: string | null; effectiveOn: string | null; reviewOn: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.decideAdjustment({ id, requestId, outcome: input.outcome,
        privateData: this.cipher.seal({ reason: input.reason }, `hr-adjustment-private:${id}`),
        operational: input.operationalInstruction === null ? null : this.cipher.seal(
          { instruction: input.operationalInstruction }, `hr-adjustment-operational:${id}`),
        effectiveOn: input.effectiveOn, reviewOn: input.reviewOn, actorId: by.accountId }, trx);
      await this.log('hr.adjustment_decided', 'hr_adjustment_request', requestId, { outcome: input.outcome }, by, trx);
      return { id };
    }));
  }

  recordAdjustmentProgress(decisionId: string, input: { action: 'implemented' | 'reviewed' | 'closed'; note: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordAdjustmentProgress({ id, decisionId, action: input.action,
        sealed: this.cipher.seal({ note: input.note }, `hr-adjustment-progress:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.adjustment_progress_recorded', 'hr_adjustment_decision', decisionId,
        { action: input.action }, by, trx);
      return { id };
    }));
  }

  async adjustments(personId: string, by: HrActor, managerProjection: boolean) {
    try {
      const [rows, progress] = await Promise.all([this.records.adjustments(personId, by.accountId, managerProjection),
        this.records.adjustmentProgress(personId, by.accountId, managerProjection)]);
      if (!managerProjection) await this.log('hr.adjustments_viewed', 'hr_person', personId, {}, by);
      return { adjustments: rows.map((row) => this.mapAdjustment(row, managerProjection)),
        progress: progress.map((row) => ({ id: row.id, decisionId: row.decision_id, action: row.action,
          note: this.open<{ note: string }>(row).note, recordedBy: row.recorded_by, recordedAt: row.recorded_at })) };
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  private mapRequest(row: LeaveRequestRow) {
    const decision = row.decision_context && row.decision_key_version && row.decision_nonce
      && row.decision_ciphertext && row.decision_auth_tag ? this.cipher.open<{ reason: string }>({
        context: row.decision_context, keyVersion: row.decision_key_version, nonce: row.decision_nonce,
        ciphertext: row.decision_ciphertext, authTag: row.decision_auth_tag }) : null;
    return { id: row.id, personId: row.person_id, policyId: row.policy_id, kind: row.kind, startsOn: row.starts_on,
      endsOn: row.ends_on, leaveYearStart: row.leave_year_start,
      reason: this.open<{ reason: string }>(row).reason, submittedBy: row.submitted_by,
      submittedAt: row.submitted_at, state: row.state, decisionReason: decision?.reason ?? null,
      decidedBy: row.decided_by, decidedAt: row.decided_at, approvedMinutes: row.approved_minutes };
  }

  private mapAdjustment(row: AdjustmentRow, manager: boolean) {
    const request = manager ? null : this.openOptional<{ request: string }>(row.request_context,
      row.request_key_version, row.request_nonce, row.request_ciphertext, row.request_auth_tag);
    const privateData = manager ? null : this.openOptional<{ reason: string }>(row.private_context,
      row.private_key_version, row.private_nonce, row.private_ciphertext, row.private_auth_tag);
    const operational = this.openOptional<{ instruction: string }>(row.operational_context,
      row.operational_key_version, row.operational_nonce, row.operational_ciphertext, row.operational_auth_tag);
    return { requestId: row.request_id, personId: row.person_id, request: request?.request ?? null,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at, decisionId: row.decision_id,
      outcome: row.outcome, decisionReason: privateData?.reason ?? null,
      operationalInstruction: operational?.instruction ?? null, effectiveOn: row.effective_on,
      reviewOn: row.review_on, decidedBy: row.decided_by, decidedAt: row.decided_at };
  }

  private open<T>(row: SealedRow): T {
    return this.cipher.open<T>({ context: row.context, keyVersion: row.key_version,
      nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag });
  }

  private openOptional<T>(context: string | null, keyVersion: number | null, nonce: Buffer | null,
    ciphertext: Buffer | null, authTag: Buffer | null): T | null {
    return context && keyVersion && nonce && ciphertext && authTag
      ? this.cipher.open<T>({ context, keyVersion, nonce, ciphertext, authTag }) : null;
  }

  private async change<T>(work: () => Promise<T>): Promise<HrLeaveChange<T>> {
    try { return { outcome: 'changed', value: await work() }; }
    catch (error) {
      if (notFound(error) || hasCode(error, '42501')) return { outcome: 'not_found' };
      if (['23505', '23514', '22007'].some((code) => hasCode(error, code))) return { outcome: 'conflict' };
      throw error;
    }
  }

  private log(action: string, type: string, id: string, metadata: Record<string, string | number>, by: HrActor,
    executor?: Parameters<AuditService['record']>[1]) {
    return this.audit.record({ actor: by.actor, action, outcome: 'success', resource: { type, id },
      metadata, ...by.context }, executor);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function notFound(error: unknown): boolean { return hasCode(error, 'P0002') || hasCode(error, '23503'); }
function hidden(error: unknown): boolean { return notFound(error) || hasCode(error, '42501'); }
