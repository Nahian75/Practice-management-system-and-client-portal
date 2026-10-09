import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { ClientPaymentEventKind } from '../database/schema.js';
import type { FinanceActor } from './finance.service.js';
import { PaymentDetailsCipher, type PaymentDetails } from './payment-details-cipher.js';
import { PaymentRepository } from './payment.repository.js';
import type { PaymentKind, PaymentRequest } from './payment.js';

const PAYMENT_PAGE_SIZE = 100;

export type PaymentChangeResult<T> =
  | { outcome: 'changed'; value: T }
  | { outcome: 'not_found' | 'conflict' };

@Injectable()
export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly audit: AuditService,
    private readonly cipher: PaymentDetailsCipher,
  ) {}

  async create(details: {
    kind: PaymentKind; matterId: string; clientBankAccountId: string;
    businessBankAccountId: string | null; billId: string | null; evidenceDocumentId: string;
    purpose: string; amountPence: string; payee: PaymentDetails | null;
  }, by: FinanceActor): Promise<PaymentChangeResult<PaymentRequest>> {
    const sealedPayee = details.payee === null ? null : this.cipher.seal(details.payee);
    try {
      const value = await this.payments.transaction(async (trx) => {
        const id = await this.payments.create({ ...details, payee: sealedPayee, actorId: by.accountId }, trx);
        const payment = await this.payments.find(id, trx);
        if (!payment) return undefined;
        await this.audit.record({
          actor: by.actor, action: 'finance.client_money_payment_requested', outcome: 'success',
          resource: { type: 'client_payment_request', id },
          metadata: { kind: payment.kind, matterId: payment.matterId, amountPence: payment.amountPence },
          ...by.context,
        }, trx);
        return payment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) {
      return databaseOutcome(error);
    }
  }

  find(id: string): Promise<PaymentRequest | undefined> {
    return this.payments.find(id);
  }

  async list(before?: string): Promise<{ paymentRequests: PaymentRequest[]; next: string | null }> {
    const paymentRequests = await this.payments.list({ before, limit: PAYMENT_PAGE_SIZE });
    return {
      paymentRequests,
      next: paymentRequests.length === PAYMENT_PAGE_SIZE ? paymentRequests.at(-1)!.id : null,
    };
  }

  async payee(id: string, by: FinanceActor): Promise<{ outcome: 'found'; value: PaymentDetails } | { outcome: 'not_found' | 'unavailable' }> {
    return this.payments.transaction(async (trx) => {
      const sealed = await this.payments.sealedPayee(id, trx);
      const request = await this.payments.find(id, trx);
      if (!request) return { outcome: 'not_found' };
      if (!['pending', 'approved'].includes(request.status)) return { outcome: 'unavailable' };
      if (!sealed) return { outcome: 'unavailable' };
      const value = this.cipher.open(sealed);
      await this.audit.record({
        actor: by.actor, action: 'finance.client_money_payment_payee_viewed', outcome: 'success',
        resource: { type: 'client_payment_request', id },
        metadata: { kind: request.kind, status: request.status }, ...by.context,
      }, trx);
      return { outcome: 'found', value };
    });
  }

  async event(id: string, event: {
    kind: ClientPaymentEventKind; reason: string | null; bankReference: string | null; occurredOn: string | null;
  }, by: FinanceActor): Promise<PaymentChangeResult<PaymentRequest>> {
    const action = auditAction(event.kind);
    try {
      const value = await this.payments.transaction(async (trx) => {
        await this.payments.recordEvent({ requestId: id, ...event, actorId: by.accountId }, trx);
        const payment = await this.payments.find(id, trx);
        if (!payment) return undefined;
        await this.audit.record({
          actor: by.actor, action, outcome: 'success', resource: { type: 'client_payment_request', id },
          metadata: { kind: payment.kind, matterId: payment.matterId, amountPence: payment.amountPence },
          ...by.context,
        }, trx);
        return payment;
      });
      return value ? { outcome: 'changed', value } : { outcome: 'conflict' };
    } catch (error) {
      const outcome = databaseOutcome<PaymentRequest>(error);
      if (outcome.outcome === 'conflict') {
        await this.audit.record({
          actor: by.actor, action, outcome: 'denied', resource: { type: 'client_payment_request', id },
          metadata: { attemptedEvent: event.kind }, ...by.context,
        });
      }
      return outcome;
    }
  }
}

function auditAction(kind: ClientPaymentEventKind): string {
  if (kind === 'paid') return 'finance.client_money_paid';
  return `finance.client_money_payment_${kind}`;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function databaseOutcome<T>(error: unknown): PaymentChangeResult<T> {
  if (hasCode(error, 'P0002') || hasCode(error, '23503')) return { outcome: 'not_found' };
  if (hasCode(error, '23505') || hasCode(error, '23514') || hasCode(error, '42501')) return { outcome: 'conflict' };
  throw error;
}
