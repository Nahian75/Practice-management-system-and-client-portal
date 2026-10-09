import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { PermissionsService } from '../auth/permissions/permissions.service.js';
import { text } from '../common/validation/safe-text.js';
import type { BankAccount, FinanceTransaction, LedgerEntry } from './finance.js';
import { FinanceService, type BillingChangeResult, type FinanceActor } from './finance.service.js';
import { billAmountToPence, penceToPounds, signedPenceToPounds } from './money.js';

const calendarDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
const financeMoney = z.string().refine((value) => {
  try { billAmountToPence(value); return true; } catch { return false; }
}, 'Invalid finance amount').transform(billAmountToPence);
const pageQuerySchema = z.strictObject({ before: z.uuid().optional() });
const bankBodySchema = z.strictObject({
  kind: z.enum(['client', 'business']), name: text(200),
  sortCode: z.string().regex(/^\d{2}-\d{2}-\d{2}$/),
  accountNumber: z.string().regex(/^\d{8}$/), openedOn: calendarDate,
});
const closeBodySchema = z.strictObject({ closedOn: calendarDate, reason: text(500) });
const receiptBodySchema = z.strictObject({
  bankAccountId: z.uuid(), matterId: z.uuid(), receivedOn: calendarDate,
  amount: financeMoney, reference: text(100), purpose: text(500),
});
const allocationBodySchema = z.strictObject({
  side: z.enum(['client', 'business']), sourceMatterId: z.uuid(), targetMatterId: z.uuid(),
  amount: financeMoney, reason: text(500),
});
const bankSchema = z.object({
  id: z.uuid(), kind: z.enum(['client', 'business']), name: z.string(), lastFour: z.string(),
  openedOn: calendarDate, closedOn: calendarDate.nullable(), createdAt: z.iso.datetime(),
});
const transactionSchema = z.object({
  id: z.uuid(), kind: z.enum(['bill', 'credit_note', 'client_receipt', 'business_receipt', 'client_allocation', 'business_allocation', 'client_payment', 'costs_transfer']),
  side: z.enum(['client', 'business']), clientId: z.uuid(), matterId: z.uuid(), relatedMatterId: z.uuid().nullable(),
  bankAccountId: z.uuid().nullable(), reference: z.string().nullable(), purpose: z.string(), amount: z.string(),
  relatedBankAccountId: z.uuid().nullable(), sourcePaymentRequestId: z.uuid().nullable(),
  occurredOn: calendarDate, postedAt: z.iso.datetime(),
});
const entrySchema = z.object({
  id: z.uuid(), transactionId: z.uuid(), kind: transactionSchema.shape.kind, side: z.enum(['client', 'business']),
  direction: z.enum(['debit', 'credit']), amount: z.string(), matterId: z.uuid(), relatedMatterId: z.uuid().nullable(),
  bankAccountId: z.uuid().nullable(), reference: z.string().nullable(), purpose: z.string(),
  relatedBankAccountId: z.uuid().nullable(),
  occurredOn: calendarDate, postedAt: z.iso.datetime(),
});
const banksSchema = z.object({ bankAccounts: z.array(bankSchema) });
const ledgerSchema = z.object({
  matterId: z.uuid(), clientBalance: z.string(), businessBalance: z.string(),
  entries: z.array(entrySchema), next: z.uuid().nullable(),
});
const cashBookSchema = z.object({
  bankAccount: bankSchema, balance: z.string(), entries: z.array(entrySchema), next: z.uuid().nullable(),
});

function actorFor(session: ResolvedSession, request: Request): FinanceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function changed<T>(result: BillingChangeResult<T>): T {
  if (result.outcome === 'not_found') throw new NotFoundException('No finance record with this id');
  if (result.outcome === 'changed_meanwhile') throw new ConflictException('The finance record changed meanwhile. Reload and try again');
  return result.value as T;
}

function responseBank(bank: BankAccount) {
  return { ...bank, createdAt: bank.createdAt.toISOString() };
}

function responseTransaction(transaction: FinanceTransaction) {
  return {
    ...transaction, amount: penceToPounds(transaction.amountPence), amountPence: undefined,
    postedAt: transaction.postedAt.toISOString(),
  };
}

function responseEntry(entry: LedgerEntry) {
  return {
    ...entry, amount: penceToPounds(entry.amountPence), amountPence: undefined,
    postedAt: entry.postedAt.toISOString(),
  };
}

@Controller('finance')
export class LedgerController {
  constructor(private readonly finance: FinanceService, private readonly permissions: PermissionsService) {}

  @Get('access')
  @RequirePermission('finance.view_all')
  @ResponseSchema(z.object({
    canManageBilling: z.boolean(), canRecordClientMoney: z.boolean(), canRequestPayment: z.boolean(),
    canApprovePayment: z.boolean(), canReconcile: z.boolean(), canSignOffReconciliation: z.boolean(),
  }))
  async access(@CurrentSession() session: ResolvedSession) {
    const has = (permission: Parameters<PermissionsService['has']>[1]) => this.permissions.has(session.account.id, permission);
    const [canManageBilling, canRecordClientMoney, canRequestPayment, canApprovePayment, canReconcile, canSignOffReconciliation] = await Promise.all([
      has('bills.manage'), has('client_money.record'), has('client_money.request'), has('client_money.approve'),
      has('finance.reconcile'), has('finance.reconciliation_sign_off'),
    ]);
    return { canManageBilling, canRecordClientMoney, canRequestPayment, canApprovePayment, canReconcile, canSignOffReconciliation };
  }

  @Post('bank-accounts')
  @RequirePermission('client_money.record')
  @ResponseSchema(bankSchema)
  async createBankAccount(@Body({ schema: bankBodySchema }) body: z.infer<typeof bankBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseBank(changed(await this.finance.createBankAccount(body, actorFor(session, request))));
  }

  @Get('bank-accounts')
  @RequirePermission('finance.view_all')
  @ResponseSchema(banksSchema)
  async listBankAccounts() {
    return { bankAccounts: (await this.finance.listBankAccounts()).map(responseBank) };
  }

  @Post('bank-accounts/:bankAccountId/close')
  @RequirePermission('client_money.record')
  @ResponseSchema(bankSchema)
  async closeBankAccount(@Param('bankAccountId', { schema: z.uuid() }) id: string, @Body({ schema: closeBodySchema }) body: z.infer<typeof closeBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseBank(changed(await this.finance.closeBankAccount(id, body.closedOn, body.reason, actorFor(session, request))));
  }

  @Post('receipts')
  @RequirePermission('client_money.record')
  @ResponseSchema(transactionSchema)
  async recordReceipt(@Body({ schema: receiptBodySchema }) body: z.infer<typeof receiptBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const { amount, ...details } = body;
    return responseTransaction(changed(await this.finance.recordReceipt({
      ...details, amountPence: amount,
    }, actorFor(session, request))));
  }

  @Post('allocations')
  @RequirePermission('client_money.record')
  @ResponseSchema(transactionSchema)
  async recordAllocation(@Body({ schema: allocationBodySchema }) body: z.infer<typeof allocationBodySchema>, @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    const { amount, ...details } = body;
    return responseTransaction(changed(await this.finance.recordAllocation({
      ...details, amountPence: amount,
    }, actorFor(session, request))));
  }

  @Get('matters/:matterId/ledger')
  @RequirePermission('finance.view_all')
  @ResponseSchema(ledgerSchema)
  async matterLedger(@Param('matterId', { schema: z.uuid() }) matterId: string, @Query({ schema: pageQuerySchema }) query: z.infer<typeof pageQuerySchema>) {
    const ledger = await this.finance.matterLedger(matterId, query.before);
    if (!ledger) throw new NotFoundException('No matter with this id');
    return {
      matterId, clientBalance: signedPenceToPounds(ledger.clientBalancePence),
      businessBalance: signedPenceToPounds(ledger.businessBalancePence),
      entries: ledger.entries.map(responseEntry), next: ledger.next,
    };
  }

  @Get('matters/:matterId/ledger/export')
  @RequirePermission('finance.view_all')
  @ResponseSchema(STREAMED)
  async exportMatterLedger(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response) {
    const file = await this.finance.exportMatterLedger(matterId, actorFor(session, request));
    if (!file) throw new NotFoundException('No matter with this id');
    sendCsv(response, file);
  }

  @Get('bank-accounts/:bankAccountId/cash-book')
  @RequirePermission('finance.view_all')
  @ResponseSchema(cashBookSchema)
  async cashBook(@Param('bankAccountId', { schema: z.uuid() }) id: string, @Query({ schema: pageQuerySchema }) query: z.infer<typeof pageQuerySchema>) {
    const book = await this.finance.cashBook(id, query.before);
    if (!book) throw new NotFoundException('No bank account with this id');
    return {
      bankAccount: responseBank(book.bankAccount), balance: signedPenceToPounds(book.balancePence),
      entries: book.entries.map(responseEntry), next: book.next,
    };
  }

  @Get('bank-accounts/:bankAccountId/cash-book/export')
  @RequirePermission('finance.view_all')
  @ResponseSchema(STREAMED)
  async exportCashBook(@Param('bankAccountId', { schema: z.uuid() }) id: string, @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response) {
    const file = await this.finance.exportCashBook(id, actorFor(session, request));
    if (!file) throw new NotFoundException('No bank account with this id');
    sendCsv(response, file);
  }
}

function sendCsv(response: Response, file: { fileName: string; content: Buffer }): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Length', String(file.content.length));
  response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  response.end(file.content);
}
