import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { PermissionsService } from '../auth/permissions/permissions.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Database } from '../database/schema.js';
import type { BillDraft, BillLineInput, CreditNote, IssuedBill, IssuedBillSummary, StaffRate, SupplierSnapshot, TimeEntry } from './finance.js';
import { FinanceRepository } from './finance.repository.js';

export const FINANCE_PAGE_SIZE = 100;

export interface FinanceActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type CreateRateResult =
  | { outcome: 'created'; rate: StaffRate }
  | { outcome: 'invalid_account' | 'duplicate' | 'changed_meanwhile' };

export type RecordTimeResult =
  | { outcome: 'created'; entry: TimeEntry }
  | { outcome: 'not_found' | 'not_open' | 'missing_rate' | 'changed_meanwhile' };

export type CorrectTimeResult =
  | { outcome: 'changed' | 'unchanged'; entry: TimeEntry }
  | { outcome: 'not_found' | 'already_voided' | 'changed_meanwhile' };

type BillDraftValues = { taxPoint: string; dueOn: string; supplier: SupplierSnapshot; lines: BillLineInput[] };
export type BillingChangeResult<T> =
  | { outcome: 'changed'; value: T }
  | { outcome: 'not_found' }
  | { outcome: 'changed_meanwhile' };

@Injectable()
export class FinanceService {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  async createBillDraft(matterId: string, details: BillDraftValues, by: FinanceActor): Promise<BillingChangeResult<BillDraft>> {
    try {
      const value = await this.finance.transaction(async (trx) => {
        const id = await this.finance.createBillDraft({ matterId, ...details, actorId: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor, action: 'bill.draft_created', outcome: 'success',
          resource: { type: 'bill_draft', id }, metadata: { matterId, lineCount: details.lines.length }, ...by.context,
        }, trx);
        return this.finance.findBillDraft(id, trx);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      return billingDatabaseOutcome(error);
    }
  }

  findBillDraft(id: string): Promise<BillDraft | undefined> {
    return this.finance.findBillDraft(id);
  }

  async replaceBillDraft(id: string, details: BillDraftValues, by: FinanceActor): Promise<BillingChangeResult<BillDraft>> {
    try {
      const value = await this.finance.transaction(async (trx) => {
        await this.finance.replaceBillDraft(id, { ...details, actorId: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor, action: 'bill.draft_updated', outcome: 'success',
          resource: { type: 'bill_draft', id }, metadata: { lineCount: details.lines.length }, ...by.context,
        }, trx);
        return this.finance.findBillDraft(id, trx);
      });
      return value ? { outcome: 'changed', value } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      return billingDatabaseOutcome(error);
    }
  }

  async issueBill(draftId: string, by: FinanceActor): Promise<BillingChangeResult<IssuedBill>> {
    try {
      const value = await this.finance.transaction(async (trx) => {
        const id = await this.finance.issueBill(draftId, by.accountId, trx);
        const bill = await this.finance.findBill(id, by.accountId, true, trx);
        if (!bill) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'bill.issued', outcome: 'success', resource: { type: 'bill', id },
          metadata: { draftId, matterId: bill.matterId, reference: bill.reference, grossPence: bill.grossPence }, ...by.context,
        }, trx);
        return bill;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      return billingDatabaseOutcome(error);
    }
  }

  async findBill(id: string, viewerId: string): Promise<IssuedBill | undefined> {
    return this.finance.findBill(id, viewerId, await this.permissions.has(viewerId, 'finance.view_all'));
  }

  async listBills(matterId: string, viewerId: string): Promise<IssuedBillSummary[] | undefined> {
    return this.finance.listBills(matterId, viewerId, await this.permissions.has(viewerId, 'finance.view_all'));
  }

  async issueCreditNote(billId: string, reason: string, lines: { billLineId: string; netPence: string }[], by: FinanceActor): Promise<BillingChangeResult<CreditNote>> {
    try {
      const value = await this.finance.transaction(async (trx) => {
        const id = await this.finance.issueCreditNote(billId, reason, lines, by.accountId, trx);
        const credit = await this.finance.findCreditNote(id, by.accountId, true, trx);
        if (!credit) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'bill.credited', outcome: 'success', resource: { type: 'credit_note', id },
          metadata: { billId, matterId: credit.matterId, reference: credit.reference, grossPence: credit.grossPence }, ...by.context,
        }, trx);
        return credit;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      return billingDatabaseOutcome(error);
    }
  }

  async findCreditNote(id: string, viewerId: string): Promise<CreditNote | undefined> {
    return this.finance.findCreditNote(id, viewerId, await this.permissions.has(viewerId, 'finance.view_all'));
  }

  async recordDelivery(target: { billId: string | null; creditNoteId: string | null; method: string; note: string | null }, by: FinanceActor): Promise<BillingChangeResult<{ id: string }>> {
    try {
      const value = await this.finance.transaction(async (trx) => {
        const id = await this.finance.recordBillDelivery({ ...target, actorId: by.accountId }, trx);
        const documentId = target.billId ?? target.creditNoteId!;
        await this.audit.record({
          actor: by.actor, action: 'bill.delivered', outcome: 'success',
          resource: { type: 'bill_delivery', id },
          metadata: { documentId, documentType: target.billId ? 'bill' : 'credit_note', method: target.method }, ...by.context,
        }, trx);
        return { id };
      });
      return { outcome: 'changed', value };
    } catch (error) {
      return billingDatabaseOutcome(error);
    }
  }

  async downloadBill(id: string, by: FinanceActor): Promise<{ fileName: string; content: Buffer } | undefined> {
    return this.finance.transaction(async (trx) => {
      const bill = await this.finance.findBill(id, by.accountId, await this.permissions.has(by.accountId, 'finance.view_all'), trx);
      if (!bill) return undefined;
      await this.audit.record({
        actor: by.actor, action: 'bill.downloaded', outcome: 'success', resource: { type: 'bill', id },
        metadata: { matterId: bill.matterId, reference: bill.reference }, ...by.context,
      }, trx);
      return { fileName: `${bill.reference}.txt`, content: Buffer.from(billText(bill), 'utf8') };
    });
  }

  async downloadCreditNote(id: string, by: FinanceActor): Promise<{ fileName: string; content: Buffer } | undefined> {
    return this.finance.transaction(async (trx) => {
      const credit = await this.finance.findCreditNote(id, by.accountId, await this.permissions.has(by.accountId, 'finance.view_all'), trx);
      if (!credit) return undefined;
      const bill = await this.finance.findBill(credit.billId, by.accountId, true, trx);
      if (!bill) return undefined;
      await this.audit.record({
        actor: by.actor, action: 'bill.credit_downloaded', outcome: 'success', resource: { type: 'credit_note', id },
        metadata: { matterId: credit.matterId, billId: credit.billId, reference: credit.reference }, ...by.context,
      }, trx);
      return { fileName: `${credit.reference}.txt`, content: Buffer.from(creditText(credit, bill), 'utf8') };
    });
  }

  async createRate(
    details: { accountId: string; hourlyRatePence: string; effectiveFrom: string },
    by: FinanceActor,
  ): Promise<CreateRateResult> {
    if (!(await this.finance.eligibleRateAccount(details.accountId))) {
      return { outcome: 'invalid_account' };
    }
    try {
      const rate = await this.finance.transaction(async (trx) => {
        const id = await this.finance.insertRate({ ...details, createdBy: by.accountId }, trx);
        await this.audit.record({
          actor: by.actor,
          action: 'rate.created',
          outcome: 'success',
          resource: { type: 'staff_rate', id },
          metadata: details,
          ...by.context,
        }, trx);
        return this.finance.findRate(id, trx);
      });
      return rate ? { outcome: 'created', rate } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      if (hasCode(error, '23505')) {
        return { outcome: 'duplicate' };
      }
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  async listRates(accountId?: string, before?: string): Promise<{ rates: StaffRate[]; next: string | null }> {
    const rates = await this.finance.listRates({ accountId, before, limit: FINANCE_PAGE_SIZE });
    return { rates, next: rates.length === FINANCE_PAGE_SIZE ? (rates.at(-1)?.id ?? null) : null };
  }

  async recordTime(
    matterId: string,
    details: { workedOn: string; minutes: number; description: string },
    by: FinanceActor,
  ): Promise<RecordTimeResult> {
    const matter = await this.finance.matterAccess(matterId, by.accountId, false);
    if (!matter) {
      return { outcome: 'not_found' };
    }
    if (matter.status !== 'open') {
      return { outcome: 'not_open' };
    }
    if (!(await this.finance.effectiveRate(by.accountId, details.workedOn))) {
      return { outcome: 'missing_rate' };
    }
    try {
      const entry = await this.finance.transaction(async (trx) => {
        const id = await this.finance.insertTime({ matterId, workerId: by.accountId, ...details }, trx);
        const created = await this.finance.findTime(id, by.accountId, false, trx);
        if (!created) {
          return undefined;
        }
        await this.audit.record({
          actor: by.actor,
          action: 'time.recorded',
          outcome: 'success',
          resource: { type: 'time_entry', id },
          metadata: { matterId, minutes: details.minutes, hourlyRatePence: created.hourlyRatePence },
          ...by.context,
        }, trx);
        return created;
      });
      return entry ? { outcome: 'created', entry } : { outcome: 'changed_meanwhile' };
    } catch (error) {
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  async listTime(matterId: string, viewerId: string, before?: string): Promise<{ timeEntries: TimeEntry[]; next: string | null } | undefined> {
    const viewAll = await this.permissions.has(viewerId, 'finance.view_all');
    const entries = await this.finance.listTime(matterId, viewerId, viewAll, { before, limit: FINANCE_PAGE_SIZE });
    if (!entries) {
      return undefined;
    }
    return { timeEntries: entries, next: entries.length === FINANCE_PAGE_SIZE ? (entries.at(-1)?.id ?? null) : null };
  }

  async findTime(id: string, viewerId: string): Promise<TimeEntry | undefined> {
    return this.finance.findTime(id, viewerId, await this.permissions.has(viewerId, 'finance.view_all'));
  }

  async correctTime(
    id: string,
    details: { replacement: { workedOn: string; minutes: number; description: string } | null; reason: string },
    by: FinanceActor,
  ): Promise<CorrectTimeResult> {
    try {
      return await this.finance.transaction(async (trx) => {
        const current = await this.finance.findOwnedForCorrection(id, by.accountId, trx);
        if (!current) {
          return { outcome: 'not_found' };
        }
        if (current.voided) {
          return { outcome: 'already_voided' };
        }
        const correction = await this.finance.insertCorrection({
          timeEntryId: id,
          replacement: details.replacement,
          reason: details.reason,
          correctedBy: by.accountId,
        }, trx);
        const entry = await this.finance.findOwnedForCorrection(id, by.accountId, trx);
        if (!entry) {
          return { outcome: 'changed_meanwhile' };
        }
        if (correction) {
          await this.recordCorrectionAudit(current, entry, details.replacement === null, by, trx);
        }
        return { outcome: correction ? 'changed' : 'unchanged', entry };
      });
    } catch (error) {
      if (hasCode(error, '23514')) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  private recordCorrectionAudit(
    current: TimeEntry,
    changed: TimeEntry,
    voided: boolean,
    by: FinanceActor,
    trx: Kysely<Database>,
  ) {
    const fields = voided
      ? ['workedOn', 'minutes', 'description', 'hourlyRate']
      : [
          ...(changed.workedOn !== current.workedOn ? ['workedOn'] : []),
          ...(changed.minutes !== current.minutes ? ['minutes'] : []),
          ...(changed.description !== current.description ? ['description'] : []),
          ...(changed.hourlyRatePence !== current.hourlyRatePence ? ['hourlyRate'] : []),
        ];
    return this.audit.record({
      actor: by.actor,
      action: 'time.corrected',
      outcome: 'success',
      resource: { type: 'time_entry', id: current.id },
      metadata: { matterId: current.matterId, voided, fields: fields.join(',') },
      ...by.context,
    }, trx);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function billingDatabaseOutcome<T>(error: unknown): BillingChangeResult<T> {
  if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
  if (hasCode(error, '23505') || hasCode(error, '23514') || hasCode(error, '42501')) return { outcome: 'changed_meanwhile' };
  throw error;
}

function money(pence: string): string {
  const value = BigInt(pence);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function addressLines(address: { addressLine1: string; addressLine2: string | null; town: string; postcode: string | null; country: string }): string[] {
  return [address.addressLine1, address.addressLine2, address.town, address.postcode, address.country].filter((line): line is string => line !== null);
}

function billText(bill: IssuedBill): string {
  return [
    bill.reference, 'BILL', '', `Issue date: ${bill.issuedOn}`, `Tax point: ${bill.taxPoint}`, `Due date: ${bill.dueOn}`, '',
    `Supplier: ${bill.supplier.name}`, ...addressLines(bill.supplier),
    ...(bill.supplier.vatRegistrationNumber ? [`VAT registration: ${bill.supplier.vatRegistrationNumber}`] : []), '',
    `Client: ${bill.clientName}`, ...addressLines(bill.clientAddress),
    `Client reference: ${bill.clientReference}`, `Matter reference: ${bill.matterReference}`, '',
    'Lines', ...bill.lines.map((line) => `${line.position}. ${line.description} | Net £${money(line.netPence)} | VAT ${line.vatTreatment} £${money(line.vatPence)} | Gross £${money(line.grossPence)}`), '',
    `Net: £${money(bill.netPence)}`, `VAT: £${money(bill.vatPence)}`, `Total: £${money(bill.grossPence)}`, '',
  ].join('\n');
}

function creditText(credit: CreditNote, bill: IssuedBill): string {
  return [
    credit.reference, 'CREDIT NOTE', '', `Issue date: ${credit.issuedOn}`,
    `Original bill: ${credit.billReference}`, `Original bill date: ${bill.issuedOn}`, `Reason: ${credit.reason}`, '',
    `Supplier: ${bill.supplier.name}`, ...addressLines(bill.supplier),
    ...(bill.supplier.vatRegistrationNumber ? [`VAT registration: ${bill.supplier.vatRegistrationNumber}`] : []), '',
    `Client: ${bill.clientName}`, ...addressLines(bill.clientAddress),
    `Client reference: ${bill.clientReference}`, `Matter reference: ${bill.matterReference}`, '',
    'Lines', ...credit.lines.map((line) => `${line.position}. ${line.description} | Net £${money(line.netPence)} | VAT £${money(line.vatPence)} | Gross £${money(line.grossPence)}`), '',
    `Net credit: £${money(credit.netPence)}`, `VAT credit: £${money(credit.vatPence)}`, `Total credit: £${money(credit.grossPence)}`, '',
  ].join('\n');
}
