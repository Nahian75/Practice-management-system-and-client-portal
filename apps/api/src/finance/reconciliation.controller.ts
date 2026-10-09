import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { discardUpload, readUpload, UploadFormError } from '../documents/upload-request.js';
import type { FinanceActor } from './finance.service.js';
import type { ClientAccountReconciliation, StatementImport } from './reconciliation.js';
import { ReconciliationService, type ReconciliationChange } from './reconciliation.service.js';
import { parseStatementCsv, signedAmountToPence, StatementCsvError } from './statement-csv.js';
import { signedPenceToPounds } from './money.js';

const date = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31');
const page = z.strictObject({ before: z.uuid().optional() });
const matchBody = z.strictObject({ financeTransactionId: z.uuid() });
const reasonBody = z.strictObject({ reason: text(500) });
const prepareBody = z.strictObject({
  asOf: date, statementImportIds: z.array(z.uuid()).min(1).max(100),
  explanations: z.record(z.string().max(200), text(1000)),
});
const idResponse = z.object({ id: z.uuid() });
const matchSchema = z.object({
  id: z.uuid(), financeTransactionId: z.uuid(), matchedBy: z.uuid(), matchedAt: z.iso.datetime(),
  reversedBy: z.uuid().nullable(), reversedAt: z.iso.datetime().nullable(), reversalReason: z.string().nullable(),
});
const statementRowSchema = z.object({
  id: z.uuid(), rowNumber: z.number().int(), occurredOn: date, amount: z.string(),
  reference: z.string(), description: z.string(), matches: z.array(matchSchema),
});
const statementSchema = z.object({
  id: z.uuid(), bankAccountId: z.uuid(), periodStart: date, periodEnd: date,
  openingBalance: z.string(), closingBalance: z.string(), fileName: z.string(),
  rowCount: z.number().int(), importedBy: z.uuid(), importedAt: z.iso.datetime(), rows: z.array(statementRowSchema),
});
const statementListSchema = z.object({ statements: z.array(statementSchema), next: z.uuid().nullable() });
const reconciliationItemSchema = z.object({
  id: z.uuid(), kind: z.enum(['unmatched_statement', 'unmatched_cashbook', 'difference']),
  sourceKey: z.string(), bankAccountId: z.uuid().nullable(), occurredOn: date.nullable(),
  amount: z.string(), reference: z.string().nullable(), explanation: z.string(),
});
const reconciliationSchema = z.object({
  id: z.uuid(), asOf: date, bankBalance: z.string(), cashbookBalance: z.string(),
  clientLedgerBalance: z.string(), bankCashbookDifference: z.string(),
  cashbookClientDifference: z.string(), preparedBy: z.uuid(), preparedAt: z.iso.datetime(),
  statementImportIds: z.array(z.uuid()), items: z.array(reconciliationItemSchema),
  signOff: z.object({ signedOffBy: z.uuid(), signedOffAt: z.iso.datetime() }).nullable(),
});
const reconciliationListSchema = z.object({ reconciliations: z.array(reconciliationSchema), next: z.uuid().nullable() });
const statusSchema = z.object({
  today: date,
  bankAccounts: z.array(z.object({
    bankAccountId: z.uuid(), kind: z.enum(['client', 'business']), lastStatementEnd: date.nullable(),
    dueOn: date, state: z.enum(['current', 'warning', 'overdue']),
  })),
  reconciliation: z.object({
    lastSignedOffAsOf: date.nullable(), dueOn: date.nullable(),
    state: z.enum(['current', 'warning', 'overdue', 'not_applicable']),
  }),
});
const importFields = ['bankAccountId', 'periodStart', 'periodEnd', 'openingBalance', 'closingBalance'] as const;

function actorFor(session: ResolvedSession, request: Request): FinanceActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function changed<T>(result: ReconciliationChange<T>): T {
  if (result.outcome === 'changed') return result.value;
  if (result.outcome === 'not_found') throw new NotFoundException('No finance record with this id');
  throw new ConflictException('The finance record conflicts with current data');
}

function responseStatement(statement: StatementImport) {
  return {
    ...statement,
    openingBalance: signedPenceToPounds(statement.openingBalancePence),
    closingBalance: signedPenceToPounds(statement.closingBalancePence),
    openingBalancePence: undefined, closingBalancePence: undefined,
    importedAt: statement.importedAt.toISOString(),
    rows: statement.rows.map((row) => ({
      ...row, amount: signedPenceToPounds(row.amountPence), amountPence: undefined,
      matches: row.matches.map((match) => ({
        ...match, matchedAt: match.matchedAt.toISOString(),
        reversedAt: match.reversedAt?.toISOString() ?? null,
      })),
    })),
  };
}

function responseReconciliation(item: ClientAccountReconciliation) {
  return {
    ...item,
    bankBalance: signedPenceToPounds(item.bankBalancePence),
    cashbookBalance: signedPenceToPounds(item.cashbookBalancePence),
    clientLedgerBalance: signedPenceToPounds(item.clientLedgerBalancePence),
    bankCashbookDifference: signedPenceToPounds(item.bankCashbookDifferencePence),
    cashbookClientDifference: signedPenceToPounds(item.cashbookClientDifferencePence),
    bankBalancePence: undefined, cashbookBalancePence: undefined,
    clientLedgerBalancePence: undefined, bankCashbookDifferencePence: undefined,
    cashbookClientDifferencePence: undefined, preparedAt: item.preparedAt.toISOString(),
    items: item.items.map((entry) => ({
      ...entry, amount: signedPenceToPounds(entry.amountPence), amountPence: undefined,
    })),
    signOff: item.signOff && { ...item.signOff, signedOffAt: item.signOff.signedOffAt.toISOString() },
  };
}

@Controller('finance')
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  @Post('statement-imports')
  @RequirePermission('finance.reconcile')
  @ResponseSchema(statementSchema)
  async import(@Req() request: Request, @CurrentSession() session: ResolvedSession) {
    let upload;
    try {
      upload = await readUpload(request, importFields);
      if (Object.keys(upload.fields).length !== importFields.length) {
        discardUpload(upload.file);
        throw new UploadFormError('Send every statement field before the file');
      }
      const fields = z.strictObject({
        bankAccountId: z.uuid(), periodStart: date, periodEnd: date,
        openingBalance: z.string(), closingBalance: z.string(),
      }).parse(upload.fields);
      const fileName = text(255).parse(upload.fileName);
      const csv = await parseStatementCsv(upload.file);
      return responseStatement(changed(await this.service.importStatement({
        bankAccountId: fields.bankAccountId, periodStart: fields.periodStart, periodEnd: fields.periodEnd,
        openingBalancePence: signedAmountToPence(fields.openingBalance, true),
        closingBalancePence: signedAmountToPence(fields.closingBalance, true), fileName, csv,
      }, actorFor(session, request))));
    } catch (error) {
      if (upload && error instanceof z.ZodError) discardUpload(upload.file);
      if (error instanceof UploadFormError || error instanceof StatementCsvError || error instanceof z.ZodError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get('statement-imports')
  @RequirePermission('finance.view_all')
  @ResponseSchema(statementListSchema)
  async listImports(@Query({ schema: page }) query: z.infer<typeof page>) {
    const statements = await this.service.listImports(query.before);
    return { statements: statements.map(responseStatement), next: statements.length === 100 ? statements.at(-1)!.id : null };
  }

  @Get('statement-imports/:statementImportId')
  @RequirePermission('finance.view_all')
  @ResponseSchema(statementSchema)
  async findImport(@Param('statementImportId', { schema: z.uuid() }) id: string) {
    const statement = await this.service.findImport(id);
    if (!statement) throw new NotFoundException('No statement import with this id');
    return responseStatement(statement);
  }

  @Post('statement-rows/:statementRowId/matches')
  @RequirePermission('finance.reconcile')
  @ResponseSchema(idResponse)
  async match(@Param('statementRowId', { schema: z.uuid() }) id: string,
    @Body({ schema: matchBody }) body: z.infer<typeof matchBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changed(await this.service.match(id, body.financeTransactionId, actorFor(session, request)));
  }

  @Post('statement-matches/:statementMatchId/reverse')
  @RequirePermission('finance.reconcile')
  @ResponseSchema(idResponse)
  async reverse(@Param('statementMatchId', { schema: z.uuid() }) id: string,
    @Body({ schema: reasonBody }) body: z.infer<typeof reasonBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return changed(await this.service.reverse(id, body.reason, actorFor(session, request)));
  }

  @Post('reconciliations')
  @RequirePermission('finance.reconcile')
  @ResponseSchema(reconciliationSchema)
  async prepare(@Body({ schema: prepareBody }) body: z.infer<typeof prepareBody>,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseReconciliation(changed(await this.service.prepare(body, actorFor(session, request))));
  }

  @Get('reconciliations')
  @RequirePermission('finance.view_all')
  @ResponseSchema(reconciliationListSchema)
  async listReconciliations(@Query({ schema: page }) query: z.infer<typeof page>) {
    const reconciliations = await this.service.listReconciliations(query.before);
    return { reconciliations: reconciliations.map(responseReconciliation), next: reconciliations.length === 100 ? reconciliations.at(-1)!.id : null };
  }

  @Get('reconciliations/status')
  @RequirePermission('finance.view_all')
  @ResponseSchema(statusSchema)
  status() { return this.service.status(); }

  @Get('reconciliations/:reconciliationId')
  @RequirePermission('finance.view_all')
  @ResponseSchema(reconciliationSchema)
  async findReconciliation(@Param('reconciliationId', { schema: z.uuid() }) id: string) {
    const item = await this.service.findReconciliation(id);
    if (!item) throw new NotFoundException('No reconciliation with this id');
    return responseReconciliation(item);
  }

  @Get('reconciliations/:reconciliationId/export')
  @RequirePermission('finance.view_all')
  @ResponseSchema(STREAMED)
  async exportReconciliation(@Param('reconciliationId', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession, @Req() request: Request, @Res() response: Response) {
    const file = await this.service.exportReconciliation(id, actorFor(session, request));
    if (!file) throw new NotFoundException('No reconciliation with this id');
    response.status(200);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Length', String(file.content.length));
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.end(file.content);
  }

  @Post('reconciliations/:reconciliationId/sign-off')
  @RequirePermission('finance.reconciliation_sign_off')
  @ResponseSchema(reconciliationSchema)
  async signOff(@Param('reconciliationId', { schema: z.uuid() }) id: string,
    @Body({ schema: z.strictObject({}) }) _body: object,
    @CurrentSession() session: ResolvedSession, @Req() request: Request) {
    return responseReconciliation(changed(await this.service.signOff(id, actorFor(session, request))));
  }
}
