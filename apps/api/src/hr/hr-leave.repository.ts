import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, HrEntitlementKind, HrFitnessStatus, HrLeaveKind } from '../database/schema.js';
import type { SealedHrData } from './hr-data-cipher.js';

type Executor = Kysely<Database>;
export interface SealedRow {
  context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
}
export interface LeaveRequestRow extends SealedRow {
  id: string; person_id: string; policy_id: string; kind: HrLeaveKind; starts_on: string; ends_on: string;
  leave_year_start: string; submitted_by: string; submitted_at: Date;
  state: 'pending' | 'approved' | 'refused' | 'cancelled'; decision_context: string | null;
  decision_key_version: number | null; decision_nonce: Buffer | null;
  decision_ciphertext: Buffer | null; decision_auth_tag: Buffer | null;
  decided_by: string | null; decided_at: Date | null; approved_minutes: number;
  account_id?: string; display_name?: string;
}
export interface AdjustmentRow {
  request_id: string; person_id: string; request_context: string | null;
  request_key_version: number | null; request_nonce: Buffer | null;
  request_ciphertext: Buffer | null; request_auth_tag: Buffer | null;
  submitted_by: string; submitted_at: Date; decision_id: string | null;
  outcome: 'agreed' | 'refused' | null; private_context: string | null;
  private_key_version: number | null; private_nonce: Buffer | null;
  private_ciphertext: Buffer | null; private_auth_tag: Buffer | null;
  operational_context: string | null; operational_key_version: number | null;
  operational_nonce: Buffer | null; operational_ciphertext: Buffer | null;
  operational_auth_tag: Buffer | null; effective_on: string | null; review_on: string | null;
  decided_by: string | null; decided_at: Date | null;
}

@Injectable()
export class HrLeaveRepository {
  constructor(@Inject(DATABASE) private readonly db: Executor) {}

  transaction<T>(work: (trx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async newId(executor: Executor = this.db): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  policies(actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrLeavePoliciesTable>>`select * from app.read_hr_leave_policies(${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  createPolicy(input: { effectiveFrom: string; leaveYearMonth: number; leaveYearDay: number;
    standardEntitlementMinutes: number; carryOverLimitMinutes: number; bookingNoticeDays: number;
    annualApprovalRoute: 'manager_or_hr' | 'hr_only'; actorId: string }, executor: Executor) {
    return sql<{ id: string }>`select app.create_hr_leave_policy(${input.effectiveFrom}::date,
      ${input.leaveYearMonth}::smallint,${input.leaveYearDay}::smallint,${input.standardEntitlementMinutes}::integer,
      ${input.carryOverLimitMinutes}::integer,${input.bookingNoticeDays}::smallint,${input.annualApprovalRoute},
      ${input.actorId}::uuid) as id`
      .execute(executor).then((result) => result.rows[0]!.id);
  }

  recordEntitlement(input: { id: string; personId: string; leaveYearStart: string;
    kind: HrEntitlementKind; minutes: number; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_leave_entitlement(${input.id}::uuid,${input.personId}::uuid,
      ${input.leaveYearStart}::date,${input.kind},${input.minutes}::integer,${input.sealed.context},
      ${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  createRequest(input: { id: string; personId: string; kind: HrLeaveKind; startsOn: string;
    endsOn: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.create_hr_leave_request(${input.id}::uuid,${input.personId}::uuid,${input.kind},
      ${input.startsOn}::date,${input.endsOn}::date,${input.sealed.context},${input.sealed.keyVersion}::smallint,
      ${input.sealed.nonce},${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`
      .execute(executor);
  }

  decideRequest(input: { eventId: string; requestId: string; action: 'approved' | 'refused';
    event: SealedHrData; entitlementId: string; entitlement: SealedHrData; actorId: string }, executor: Executor) {
    return sql<{ minutes: number }>`select app.decide_hr_leave_request(${input.eventId}::uuid,
      ${input.requestId}::uuid,${input.action},${input.event.context},${input.event.keyVersion}::smallint,
      ${input.event.nonce},${input.event.ciphertext},${input.event.authTag},${input.entitlementId}::uuid,
      ${input.entitlement.context},${input.entitlement.keyVersion}::smallint,${input.entitlement.nonce},
      ${input.entitlement.ciphertext},${input.entitlement.authTag},${input.actorId}::uuid) as minutes`
      .execute(executor).then((result) => result.rows[0]!.minutes);
  }

  cancelRequest(input: { eventId: string; requestId: string; event: SealedHrData;
    entitlementId: string; entitlement: SealedHrData; actorId: string }, executor: Executor) {
    return sql<{ minutes: number }>`select app.cancel_hr_leave_request(${input.eventId}::uuid,
      ${input.requestId}::uuid,${input.event.context},${input.event.keyVersion}::smallint,${input.event.nonce},
      ${input.event.ciphertext},${input.event.authTag},${input.entitlementId}::uuid,
      ${input.entitlement.context},${input.entitlement.keyVersion}::smallint,${input.entitlement.nonce},
      ${input.entitlement.ciphertext},${input.entitlement.authTag},${input.actorId}::uuid) as minutes`
      .execute(executor).then((result) => result.rows[0]!.minutes);
  }

  requests(personId: string, actorId: string) {
    return sql<LeaveRequestRow>`select * from app.read_hr_leave_requests(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  pendingRequests(actorId: string) {
    return sql<LeaveRequestRow>`select *, 'pending'::text as state, null::text as decision_context,
      null::smallint as decision_key_version,null::bytea as decision_nonce,null::bytea as decision_ciphertext,
      null::bytea as decision_auth_tag,null::uuid as decided_by,null::timestamptz as decided_at,
      0::integer as approved_minutes from app.list_hr_pending_leave_requests(${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  entitlement(personId: string, actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrLeaveEntitlementEntriesTable>>`
      select * from app.read_hr_leave_entitlement(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  holidayPay(personId: string, actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrHolidayPayRecordsTable>>`
      select * from app.read_hr_holiday_pay(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  recordHolidayPay(input: { personId: string; requestId: string; periodStartsOn: string;
    periodEndsOn: string; amountPence: number; basis: 'normal' | 'basic' | 'rolled_up' | 'other';
    includedElements: Array<{ name: string; amountPence: number }>; actorId: string }, executor: Executor) {
    return sql<{ id: string }>`select app.record_hr_holiday_pay(${input.personId}::uuid,${input.requestId}::uuid,
      ${input.periodStartsOn}::date,${input.periodEndsOn}::date,${input.amountPence}::bigint,${input.basis},
      ${JSON.stringify(input.includedElements)}::jsonb,${input.actorId}::uuid) as id`
      .execute(executor).then((result) => result.rows[0]!.id);
  }

  sickness(personId: string, actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrSicknessAbsencesTable>>`
      select * from app.read_hr_sickness(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  recordSickness(input: { personId: string; startedOn: string; endedOn: string | null;
    notifiedAt: string; fitnessStatus: HrFitnessStatus; actorId: string }, executor: Executor) {
    return sql<{ id: string }>`select app.record_hr_sickness(${input.personId}::uuid,${input.startedOn}::date,
      ${input.endedOn}::date,${input.notifiedAt}::timestamptz,${input.fitnessStatus},${input.actorId}::uuid) as id`
      .execute(executor).then((result) => result.rows[0]!.id);
  }

  health(personId: string, actorId: string) {
    return sql<Selectable<import('../database/schema.js').HrHealthRecordsTable>>`
      select * from app.read_hr_health(${personId}::uuid,${actorId}::uuid)`
      .execute(this.db).then((result) => result.rows);
  }

  recordHealth(input: { id: string; personId: string; kind: 'sickness_detail' | 'fit_note' | 'occupational_health' | 'adjustment_ground';
    validFrom: string | null; validTo: string | null; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_health(${input.id}::uuid,${input.personId}::uuid,${input.kind},
      ${input.validFrom}::date,${input.validTo}::date,${input.sealed.context},${input.sealed.keyVersion}::smallint,
      ${input.sealed.nonce},${input.sealed.ciphertext},${input.sealed.authTag},${input.actorId}::uuid)`
      .execute(executor);
  }

  adjustments(personId: string, actorId: string, managerProjection: boolean) {
    return sql<AdjustmentRow>`select * from app.read_hr_adjustments(${personId}::uuid,${actorId}::uuid,
      ${managerProjection}::boolean)`.execute(this.db).then((result) => result.rows);
  }

  adjustmentProgress(personId: string, actorId: string, managerProjection: boolean) {
    return sql<Selectable<import('../database/schema.js').HrAdjustmentProgressEventsTable>>`
      select * from app.read_hr_adjustment_progress(${personId}::uuid,${actorId}::uuid,${managerProjection}::boolean)`
      .execute(this.db).then((result) => result.rows);
  }

  createAdjustment(input: { id: string; personId: string; sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.create_hr_adjustment_request(${input.id}::uuid,${input.personId}::uuid,
      ${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  decideAdjustment(input: { id: string; requestId: string; outcome: 'agreed' | 'refused';
    privateData: SealedHrData; operational: SealedHrData | null; effectiveOn: string | null;
    reviewOn: string | null; actorId: string }, executor: Executor) {
    const operational = input.operational;
    return sql`select app.decide_hr_adjustment(${input.id}::uuid,${input.requestId}::uuid,${input.outcome},
      ${input.privateData.context},${input.privateData.keyVersion}::smallint,${input.privateData.nonce},
      ${input.privateData.ciphertext},${input.privateData.authTag},${operational?.context ?? null},
      ${operational?.keyVersion ?? null}::smallint,${operational?.nonce ?? null},${operational?.ciphertext ?? null},
      ${operational?.authTag ?? null},${input.effectiveOn}::date,${input.reviewOn}::date,${input.actorId}::uuid)`
      .execute(executor);
  }

  recordAdjustmentProgress(input: { id: string; decisionId: string; action: 'implemented' | 'reviewed' | 'closed';
    sealed: SealedHrData; actorId: string }, executor: Executor) {
    return sql`select app.record_hr_adjustment_progress(${input.id}::uuid,${input.decisionId}::uuid,${input.action},
      ${input.sealed.context},${input.sealed.keyVersion}::smallint,${input.sealed.nonce},${input.sealed.ciphertext},
      ${input.sealed.authTag},${input.actorId}::uuid)`.execute(executor);
  }
}
