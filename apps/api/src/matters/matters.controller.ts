import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { SEARCH_LIMIT_MESSAGE, SEARCH_WINDOW_SECONDS } from '../clients/search-quota.js';
import { text } from '../common/validation/safe-text.js';
import type { ConflictCheck } from './matter.js';
import { MattersService, type MatterActor, type TeamChangeResult } from './matters.service.js';

const MATTER_TYPES = [
  'residential_property',
  'commercial_property',
  'family',
  'litigation',
  'employment',
  'wills_probate',
  'corporate',
  'immigration',
  'crime',
  'other',
] as const;
const MATTER_STATUSES = ['awaiting_clearance', 'open', 'closed'] as const;
const PARTY_ROLES = ['opponent', 'opponent_solicitor', 'other'] as const;
const KINDS = ['individual', 'organisation'] as const;
const RELATIONS = ['client', 'contact', 'opponent', 'opponent_solicitor', 'other_party'] as const;

const conflictCheckRequestSchema = z.strictObject({
  clientId: z.uuid(),
  names: z.array(text(200)).min(1).max(20),
});
const partySchema = z.strictObject({ role: z.enum(PARTY_ROLES), kind: z.enum(KINDS), name: text(200) });

const newMatterSchema = z.strictObject({
  clientId: z.uuid(),
  title: text(200),
  matterType: z.enum(MATTER_TYPES),
  supervisingPartnerId: z.uuid(),
  feeEarnerIds: z
    .array(z.uuid())
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Each fee earner once')
    .default([]),
  conflictCheckId: z.uuid(),
  parties: z.array(partySchema).max(20).default([]),
});
const listQuerySchema = z.strictObject({ before: z.uuid().optional() });

const summarySchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  title: z.string(),
  matterType: z.enum(MATTER_TYPES),
  status: z.enum(MATTER_STATUSES),
  client: z.object({ id: z.uuid(), reference: z.string(), kind: z.enum(['individual', 'organisation']), name: z.string() }),
});
const matterSchema = summarySchema.extend({
  openedAt: z.iso.datetime(),
  parties: z.array(z.object({ id: z.uuid(), role: z.enum(PARTY_ROLES), kind: z.enum(KINDS), name: z.string() })),
  team: z.array(
    z.object({ accountId: z.uuid(), displayName: z.string(), role: z.enum(['supervising_partner', 'fee_earner']) }),
  ),
});
const conflictCheckSchema = z.object({
  id: z.uuid(),
  names: z.array(z.string()),
  matchCount: z.number().int(),
  createdAt: z.iso.datetime(),
  matches: z.array(
    z.object({
      checkedName: z.string(),
      matchedName: z.string(),
      relation: z.enum(RELATIONS),
      clientReference: z.string(),
      matterReference: z.string().nullable(),
    }),
  ),
  clearance: z
    .object({
      clearedBy: z.object({ accountId: z.uuid(), displayName: z.string() }),
      reason: z.string(),
      clearedAt: z.iso.datetime(),
    })
    .nullable(),
});
const clearanceRequestSchema = z.strictObject({ reason: text(500, 10) });
const handOverSchema = z.strictObject({ accountId: z.uuid() });
const openedSchema = z.object({ id: z.uuid(), reference: z.string(), status: z.enum(MATTER_STATUSES) });
const listSchema = z.object({ matters: z.array(summarySchema), next: z.uuid().nullable() });
const clientMattersSchema = z.object({ matters: z.array(summarySchema) });

export const MATTER_NOT_FOUND_MESSAGE = 'No matter with this id';
const CLIENT_NOT_FOUND_MESSAGE = 'No client with this id';

const serialiseCheck = (check: ConflictCheck) => ({
  ...check,
  createdAt: check.createdAt.toISOString(),
  clearance: check.clearance && { ...check.clearance, clearedAt: check.clearance.clearedAt.toISOString() },
});

/** Every team change answers the same way; 204 also when nothing needed to change. */
function answerTeamChange(result: TeamChangeResult): void {
  switch (result) {
    case 'not_found':
      throw new NotFoundException(MATTER_NOT_FOUND_MESSAGE);
    case 'not_supervisor':
      throw new ForbiddenException("Only the matter's supervising partner can change its team");
    case 'invalid_member':
      throw new BadRequestException('Team members must be active staff who can work on matters; a supervising partner must be a partner');
    case 'is_supervisor':
      throw new ConflictException('The supervising partner leaves the team only by handing over to another partner');
    case 'changed':
    case 'unchanged':
      return;
  }
}

function actorFor(session: ResolvedSession, request: Request): MatterActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

@Controller()
export class MattersController {
  constructor(private readonly matters: MattersService) {}

  @Post('matters')
  @RequirePermission('matters.open')
  @ResponseSchema(openedSchema)
  async open(
    @Body({ schema: newMatterSchema }) body: z.infer<typeof newMatterSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.matters.open(body, actorFor(session, request));
    switch (result.outcome) {
      case 'client_not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'invalid_supervisor':
        throw new BadRequestException('The supervising partner must be an active partner');
      case 'invalid_team_member':
        throw new BadRequestException('Every team member must be active staff who can work on matters');
      case 'invalid_conflict_check':
        throw new BadRequestException(
          'The conflict check must be your own, for this client, from the last 24 hours, and not used for another matter',
        );
      case 'party_not_checked':
        throw new BadRequestException('Every other party must have been in the conflict check');
      case 'opened':
        return { id: result.id, reference: result.reference, status: result.status };
    }
  }

  /** Checks the names against every client, contact and other party, within the hourly search allowance. */
  @Post('conflict-checks')
  @RequirePermission('matters.open')
  @ResponseSchema(conflictCheckSchema)
  async runConflictCheck(
    @Body({ schema: conflictCheckRequestSchema }) body: z.infer<typeof conflictCheckRequestSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.matters.runConflictCheck(body.clientId, body.names, actorFor(session, request));
    switch (result.outcome) {
      case 'client_not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'limited':
        response.setHeader('Retry-After', String(SEARCH_WINDOW_SECONDS));
        throw new HttpException(SEARCH_LIMIT_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
      case 'checked':
        return serialiseCheck(result.check);
    }
  }

  @Get('matters')
  @RequirePermission('matters.view')
  @ResponseSchema(listSchema)
  list(@Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>, @CurrentSession() session: ResolvedSession) {
    return this.matters.list(session.account.id, query.before);
  }

  /** A matter the caller is not on the team of answers 404, like one that does not exist. */
  @Get('matters/:matterId')
  @RequirePermission('matters.view')
  @ResponseSchema(matterSchema)
  async find(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession) {
    const matter = await this.matters.find(matterId, session.account.id);
    if (!matter) {
      throw new NotFoundException(MATTER_NOT_FOUND_MESSAGE);
    }
    return { ...matter, openedAt: matter.openedAt.toISOString() };
  }

  /** The conflict check the matter was opened on, with its possible matches, for its team. */
  @Get('matters/:matterId/conflict-check')
  @RequirePermission('matters.view')
  @ResponseSchema(conflictCheckSchema)
  async conflictCheck(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession) {
    const check = await this.matters.conflictCheckOf(matterId, session.account.id);
    if (!check) {
      throw new NotFoundException(MATTER_NOT_FOUND_MESSAGE);
    }
    return serialiseCheck(check);
  }

  /** The supervising partner records why the possible matches are not a conflict, which opens the matter. */
  @Post('matters/:matterId/conflict-clearance')
  @RequirePermission('matters.supervise')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async clearConflict(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: clearanceRequestSchema }) body: z.infer<typeof clearanceRequestSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    switch (await this.matters.clearConflict(matterId, body.reason, actorFor(session, request))) {
      case 'not_found':
        throw new NotFoundException(MATTER_NOT_FOUND_MESSAGE);
      case 'not_supervisor':
        throw new ForbiddenException("Only the matter's supervising partner can clear a possible conflict");
      case 'not_awaiting_clearance':
        throw new ConflictException('This matter is not awaiting conflict clearance');
      case 'cleared':
        return;
    }
  }

  @Put('matters/:matterId/team/:accountId')
  @RequirePermission('matters.supervise')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async addFeeEarner(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('accountId', { schema: z.uuid() }) accountId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    answerTeamChange(await this.matters.addFeeEarner(matterId, accountId, actorFor(session, request)));
  }

  @Delete('matters/:matterId/team/:accountId')
  @RequirePermission('matters.supervise')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async removeFeeEarner(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Param('accountId', { schema: z.uuid() }) accountId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    answerTeamChange(await this.matters.removeFeeEarner(matterId, accountId, actorFor(session, request)));
  }

  /** The previous supervising partner stays on the team as a fee earner. */
  @Post('matters/:matterId/supervisor')
  @RequirePermission('matters.supervise')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async handOverSupervision(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: handOverSchema }) body: z.infer<typeof handOverSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    answerTeamChange(await this.matters.handOverSupervision(matterId, body.accountId, actorFor(session, request)));
  }

  @Get('clients/:clientId/matters')
  @RequirePermission('matters.view')
  @ResponseSchema(clientMattersSchema)
  async listForClient(@Param('clientId', { schema: z.uuid() }) clientId: string, @CurrentSession() session: ResolvedSession) {
    const matters = await this.matters.listForClient(clientId, session.account.id);
    if (!matters) {
      throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
    }
    return { matters };
  }
}
