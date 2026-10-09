import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { ClientPaymentEventKind, Database } from '../database/schema.js';
import type { SealedPaymentDetails } from './payment-details-cipher.js';
import type { PaymentEvent, PaymentRequest } from './payment.js';

type PaymentRow = Omit<Selectable<Database['client_payment_requests']>,
  'payee_context' | 'payee_key_version' | 'payee_nonce' | 'payee_ciphertext' | 'payee_auth_tag'>
  & { requester_name: string };

@Injectable()
export class PaymentRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async create(details: {
    kind: PaymentRequest['kind']; matterId: string; clientBankAccountId: string;
    businessBankAccountId: string | null; billId: string | null; evidenceDocumentId: string;
    purpose: string; amountPence: string; payee: SealedPaymentDetails | null; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.create_client_payment_request(
      ${details.kind}, ${details.clientBankAccountId}, ${details.businessBankAccountId},
      ${details.matterId}, ${details.billId}, ${details.evidenceDocumentId},
      ${details.purpose}, ${details.amountPence}::bigint, ${details.payee?.context ?? null}::uuid,
      ${details.payee?.keyVersion ?? null}::smallint, ${details.payee?.nonce ?? null}::bytea,
      ${details.payee?.ciphertext ?? null}::bytea, ${details.payee?.authTag ?? null}::bytea,
      ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async recordEvent(details: {
    requestId: string; kind: ClientPaymentEventKind; reason: string | null;
    bankReference: string | null; occurredOn: string | null; actorId: string;
  }, trx: Kysely<Database>): Promise<string> {
    const result = await sql<{ id: string }>`select app.record_client_payment_event(
      ${details.requestId}, ${details.kind}, ${details.reason}, ${details.bankReference},
      ${details.occurredOn}::date, ${details.actorId}
    ) as id`.execute(trx);
    return result.rows[0]!.id;
  }

  async find(id: string, executor: Kysely<Database> = this.db): Promise<PaymentRequest | undefined> {
    const row = await this.safeRows(executor)
      .where('client_payment_requests.id', '=', id).executeTakeFirst();
    return row && this.withEvents(row, executor);
  }

  async list(page: { before?: string; limit: number }): Promise<PaymentRequest[]> {
    const rows = await this.safeRows(this.db)
      .$if(page.before !== undefined, (query) => query.where('client_payment_requests.id', '<', page.before as string))
      .orderBy('client_payment_requests.id', 'desc').limit(page.limit).execute();
    return Promise.all(rows.map((row) => this.withEvents(row, this.db)));
  }

  async sealedPayee(id: string, executor: Kysely<Database> = this.db): Promise<SealedPaymentDetails | undefined> {
    const row = (await sql<{
      context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
    }>`select * from app.read_client_payment_payee(${id})`.execute(executor)).rows[0];
    if (!row) return undefined;
    return {
      context: row.context, keyVersion: row.key_version, nonce: row.nonce,
      ciphertext: row.ciphertext, authTag: row.auth_tag,
    };
  }

  private async withEvents(
    row: PaymentRow,
    executor: Kysely<Database>,
  ): Promise<PaymentRequest> {
    const events = await executor.selectFrom('client_payment_events')
      .innerJoin('accounts as actor', 'actor.id', 'client_payment_events.acted_by')
      .selectAll('client_payment_events').select('actor.display_name as actor_name')
      .where('payment_request_id', '=', row.id).orderBy('client_payment_events.id').execute();
    const mapped: PaymentEvent[] = events.map((event) => ({
      id: event.id, kind: event.kind, reason: event.reason, bankReference: event.bank_reference,
      occurredOn: event.occurred_on, financeTransactionId: event.finance_transaction_id,
      actedBy: { accountId: event.acted_by, displayName: event.actor_name }, actedAt: event.acted_at,
    }));
    return {
      id: row.id, kind: row.kind, clientId: row.client_id, matterId: row.matter_id,
      clientBankAccountId: row.client_bank_account_id, businessBankAccountId: row.business_bank_account_id,
      billId: row.bill_id, evidenceDocumentId: row.evidence_document_id, purpose: row.purpose,
      amountPence: row.amount_pence,
      requestedBy: { accountId: row.requested_by, displayName: row.requester_name },
      requestedAt: row.requested_at, status: mapped.at(-1)?.kind ?? 'pending', events: mapped,
    };
  }

  private safeRows(executor: Kysely<Database>) {
    return executor.selectFrom('client_payment_requests')
      .innerJoin('accounts as requester', 'requester.id', 'client_payment_requests.requested_by')
      .select([
        'client_payment_requests.id', 'client_payment_requests.kind', 'client_payment_requests.client_id',
        'client_payment_requests.matter_id', 'client_payment_requests.client_bank_account_id',
        'client_payment_requests.business_bank_account_id', 'client_payment_requests.bill_id',
        'client_payment_requests.evidence_document_id', 'client_payment_requests.purpose',
        'client_payment_requests.amount_pence', 'client_payment_requests.requested_by',
        'client_payment_requests.requested_at', 'requester.display_name as requester_name',
      ]);
  }
}
