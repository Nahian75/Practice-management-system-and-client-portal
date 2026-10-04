import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { MattersService, type MatterActor } from './matters.service.js';

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
  team: z.array(
    z.object({ accountId: z.uuid(), displayName: z.string(), role: z.enum(['supervising_partner', 'fee_earner']) }),
  ),
});
const openedSchema = z.object({ id: z.uuid(), reference: z.string(), status: z.enum(MATTER_STATUSES) });
const listSchema = z.object({ matters: z.array(summarySchema), next: z.uuid().nullable() });
const clientMattersSchema = z.object({ matters: z.array(summarySchema) });

export const MATTER_NOT_FOUND_MESSAGE = 'No matter with this id';
const CLIENT_NOT_FOUND_MESSAGE = 'No client with this id';

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
      case 'opened':
        return { id: result.id, reference: result.reference, status: result.status };
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
