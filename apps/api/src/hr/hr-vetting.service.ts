import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import type { Database } from '../database/schema.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrVettingRepository, type LifecycleRow, type ProfessionalRow } from './hr-vetting.repository.js';
import type { HrActor } from './hr.service.js';

export type HrVettingChange<T> = { outcome: 'changed'; value: T } | { outcome: 'not_found' | 'conflict' };

@Injectable()
export class HrVettingService {
  constructor(private readonly records: HrVettingRepository, private readonly cipher: HrDataCipher,
    private readonly audit: AuditService) {}

  createChecklist(personId: string, input: { engagementId: string; kind: 'joiner' | 'mover' | 'leaver';
    effectiveOn: string; reasonCategory: string | null; items: Array<{ code: string; title: string;
      ownerKind: 'hr' | 'administrator' | 'manager' | 'worker' | 'other_module'; required: boolean;
      dueOn: string | null }> }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createChecklist({ id, personId, ...input, actorId: by.accountId }, trx);
      for (const item of input.items) {
        await this.records.addChecklistItem({ id: await this.records.newId(trx), checklistId: id,
          ...item, actorId: by.accountId }, trx);
      }
      await this.log('hr.lifecycle_created', 'hr_lifecycle_checklist', id,
        { personId, kind: input.kind, itemCount: input.items.length, effectiveOn: input.effectiveOn }, by, trx);
      return { id };
    }));
  }

  recordItemEvent(itemId: string, input: { action: 'completed' | 'reopened'; note: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordItemEvent({ id, itemId, action: input.action,
        sealed: this.cipher.seal({ note: input.note }, `hr-lifecycle-item-event:${id}`),
        actorId: by.accountId }, trx);
      await this.log(`hr.lifecycle_item_${input.action}`, 'hr_lifecycle_item', itemId, {}, by, trx);
      return { id };
    }));
  }

  recordChecklistEvent(checklistId: string, input: { action: 'completed' | 'reopened'; note: string }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordChecklistEvent({ id, checklistId, action: input.action,
        sealed: this.cipher.seal({ note: input.note }, `hr-lifecycle-event:${id}`), actorId: by.accountId }, trx);
      await this.log(`hr.lifecycle_${input.action}`, 'hr_lifecycle_checklist', checklistId, {}, by, trx);
      return { id };
    }));
  }

  async lifecycle(personId: string, actorId: string) {
    try { return groupLifecycle(await this.records.lifecycle(personId, actorId)); }
    catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  async blockers(checklistId: string, actorId: string) {
    try { return (await this.records.blockers(checklistId, actorId)).map((row) => ({
      kind: row.kind, resourceId: row.resource_id, status: row.status })); }
    catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  recordRightToWork(personId: string, input: { engagementId: string; guidanceVersion: string;
    checkRoute: 'manual' | 'online' | 'digital_provider'; checkedOn: string;
    permissionType: 'british_or_irish' | 'settled' | 'pre_settled' | 'time_limited' | 'other';
    result: 'passed' | 'failed' | 'follow_up_required'; expiresOn: string | null; followUpOn: string | null;
    evidenceFileId: string; identityMatchMethod: string; workRestrictions: string | null;
    providerReference: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      const version = await this.records.recordRightToWork({ id, personId, ...input,
        sealed: this.cipher.seal({ identityMatchMethod: input.identityMatchMethod,
          workRestrictions: input.workRestrictions, providerReference: input.providerReference }, `hr-rtw:${id}`),
        actorId: by.accountId }, trx);
      await this.log('hr.right_to_work_recorded', 'hr_right_to_work_check', id,
        { personId, engagementId: input.engagementId, version }, by, trx);
      return { id, version };
    }));
  }

  async vetting(personId: string, by: HrActor, view: 'self' | 'manager' | 'hr') {
    try {
      const [status, professional, checks] = await Promise.all([
        this.records.rightToWorkStatus(personId, by.accountId),
        this.records.professional(personId, by.accountId, view === 'manager'),
        view === 'hr' ? this.records.rightToWorkChecks(personId, by.accountId) : Promise.resolve([]),
      ]);
      if (view === 'hr') await this.log('hr.vetting_viewed', 'hr_person', personId, {}, by);
      return {
        rightToWork: status.map((row) => ({ id: row.id, engagementId: row.engagement_id, version: row.version,
          result: view === 'manager' ? null : row.result,
          permissionType: view === 'manager' ? null : row.permission_type,
          checkedOn: view === 'manager' ? null : row.checked_on, expiresOn: row.expires_on,
          followUpOn: row.follow_up_on, overdue: row.overdue, actionRequired: row.action_required })),
        rightToWorkChecks: checks.map((row) => ({ id: row.id, engagementId: row.engagement_id,
          version: row.version, previousCheckId: row.previous_check_id, guidanceVersion: row.guidance_version,
          checkRoute: row.check_route, checkedOn: row.checked_on, permissionType: row.permission_type,
          result: row.result, expiresOn: row.expires_on, followUpOn: row.follow_up_on,
          evidenceFileId: row.evidence_file_id, details: this.open<{ identityMatchMethod: string;
            workRestrictions: string | null; providerReference: string | null }>(row),
          checkedBy: row.checked_by, recordedAt: row.recorded_at })),
        professional: professional.map((row) => this.mapProfessional(row, view === 'manager')),
      };
    } catch (error) { if (hidden(error)) return undefined; throw error; }
  }

  async due(actorId: string) {
    return (await this.records.vettingDue(actorId)).map((row) => ({ personId: row.person_id,
      accountId: row.account_id, displayName: row.display_name, checkId: row.check_id,
      engagementId: row.engagement_id, result: row.result, expiresOn: row.expires_on,
      followUpOn: row.follow_up_on, overdue: row.overdue }));
  }

  createProfessional(personId: string, input: { kind: 'qualification' | 'professional_registration' | 'practising_certificate';
    title: string; issuer: string; validFrom: string | null; validTo: string | null;
    identifier: string | null; restriction: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.createProfessional({ id, personId, ...input,
        sealed: this.cipher.seal({ identifier: input.identifier, restriction: input.restriction },
          `hr-professional:${id}`), actorId: by.accountId }, trx);
      await this.log('hr.professional_recorded', 'hr_professional_record', id,
        { personId, kind: input.kind }, by, trx);
      return { id };
    }));
  }

  recordProfessionalCheck(recordId: string, input: { status: 'current' | 'expired' | 'restricted' | 'suspended' | 'not_verified';
    checkedOn: string; source: string; note: string | null }, by: HrActor) {
    return this.change(async () => this.records.transaction(async (trx) => {
      const id = await this.records.newId(trx);
      await this.records.recordProfessionalCheck({ id, recordId, status: input.status, checkedOn: input.checkedOn,
        sealed: this.cipher.seal({ source: input.source, note: input.note }, `hr-professional-check:${id}`),
        actorId: by.accountId }, trx);
      await this.log('hr.professional_check_recorded', 'hr_professional_record', recordId,
        { status: input.status, checkedOn: input.checkedOn }, by, trx);
      return { id };
    }));
  }

  private mapProfessional(row: ProfessionalRow, manager: boolean) {
    const details = manager ? null : this.openOptional<{ identifier: string | null; restriction: string | null }>(
      row.context,row.key_version,row.nonce,row.ciphertext,row.auth_tag);
    const check = manager ? null : this.openOptional<{ source: string; note: string | null }>(row.check_context,
      row.check_key_version,row.check_nonce,row.check_ciphertext,row.check_auth_tag);
    return { id: row.id, personId: row.person_id, kind: row.kind, title: row.title, issuer: row.issuer,
      validFrom: row.valid_from, validTo: row.valid_to, identifier: details?.identifier ?? null,
      restriction: details?.restriction ?? null, status: row.status, checkedOn: row.checked_on,
      source: check?.source ?? null, checkNote: check?.note ?? null, recordedBy: row.recorded_by,
      recordedAt: row.recorded_at, checkedBy: row.checked_by, checkRecordedAt: row.check_recorded_at };
  }

  private open<T>(row: { context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer }): T {
    return this.cipher.open<T>({ context: row.context, keyVersion: row.key_version,
      nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag });
  }

  private openOptional<T>(context: string | null,keyVersion: number | null,nonce: Buffer | null,
    ciphertext: Buffer | null,authTag: Buffer | null): T | null {
    return context && keyVersion && nonce && ciphertext && authTag
      ? this.cipher.open<T>({ context,keyVersion,nonce,ciphertext,authTag }) : null;
  }

  private async change<T>(work: () => Promise<T>): Promise<HrVettingChange<T>> {
    try { return { outcome: 'changed', value: await work() }; }
    catch (error) {
      if (hidden(error)) return { outcome: 'not_found' };
      if (['23505','23514','22007'].some((code) => hasCode(error,code))) return { outcome: 'conflict' };
      throw error;
    }
  }

  private log(action: string,type: string,id: string,metadata: Record<string,string | number>,by: HrActor,
    executor?: Kysely<Database>) {
    return this.audit.record({ actor: by.actor,action,outcome:'success',resource:{ type,id },metadata,...by.context },executor);
  }
}

function groupLifecycle(rows: LifecycleRow[]) {
  const grouped = new Map<string,{ id: string; engagementId: string; kind: LifecycleRow['kind']; effectiveOn: string;
    reasonCategory: string | null; state: LifecycleRow['checklist_state']; items: Array<{ id: string; code: string;
      title: string; ownerKind: string; required: boolean; dueOn: string | null; state: string }> }>();
  for (const row of rows) {
    const checklist = grouped.get(row.checklist_id) ?? { id: row.checklist_id,engagementId: row.engagement_id,
      kind: row.kind,effectiveOn: row.effective_on,reasonCategory: row.reason_category,
      state: row.checklist_state,items: [] };
    if (row.item_id && row.code && row.title && row.owner_kind && row.required !== null && row.item_state) {
      checklist.items.push({ id: row.item_id,code: row.code,title: row.title,ownerKind: row.owner_kind,
        required: row.required,dueOn: row.due_on,state: row.item_state });
    }
    grouped.set(row.checklist_id,checklist);
  }
  return [...grouped.values()];
}
function hasCode(error: unknown,code: string) { return error instanceof Error && 'code' in error && error.code===code; }
function hidden(error: unknown) { return ['P0002','23503','42501'].some((code) => hasCode(error,code)); }
