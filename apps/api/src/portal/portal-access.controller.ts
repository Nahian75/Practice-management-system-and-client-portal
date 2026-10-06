import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { PortalService, type PortalActor } from './portal.service.js';

const grantSchema = z.strictObject({ contactId: z.uuid().optional() });
const grantedSchema = z.object({ id: z.uuid(), accountId: z.uuid(), invited: z.boolean() });
const peopleSchema = z.object({
  people: z.array(
    z.object({
      id: z.uuid(),
      accountId: z.uuid(),
      contactId: z.uuid().nullable(),
      name: z.string(),
      email: z.string(),
      accountStatus: z.enum(['invited', 'active', 'disabled']),
      linkedAt: z.iso.datetime(),
    }),
  ),
});

const CLIENT_NOT_FOUND_MESSAGE = 'No client with this id';

function actorFor(session: ResolvedSession, request: Request): PortalActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

/** Staff giving a client's people access to the portal (docs/portal.md), and ending it. */
@Controller('clients/:clientId/portal-access')
export class PortalAccessController {
  constructor(private readonly portal: PortalService) {}

  /**
   * For an individual client, no body is needed; for an organisation,
   * `contactId` names the contact. The invitation goes to the address on
   * their record.
   */
  @Post()
  @RequirePermission('portal.invite')
  @ResponseSchema(grantedSchema)
  async grant(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: grantSchema }) body: z.infer<typeof grantSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.portal.grant(clientId, body.contactId, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'no_such_person':
        throw new BadRequestException('Name one of the organisation’s current contacts; an individual client needs no contact');
      case 'no_email':
        throw new ConflictException('Add an email address to their record first: the invitation goes only there');
      case 'already_linked':
        throw new ConflictException('They already have access to this client in the portal');
      case 'email_used_by_staff':
        throw new ConflictException('This email address belongs to a staff account and cannot be used for the portal');
      case 'account_disabled':
        throw new ConflictException('Their portal account is disabled; an administrator must re-enable it first');
      case 'granted':
        return { id: result.linkId, accountId: result.accountId, invited: result.invited };
    }
  }

  @Get()
  @RequirePermission('portal.invite')
  @ResponseSchema(peopleSchema)
  async people(@Param('clientId', { schema: z.uuid() }) clientId: string, @CurrentSession() session: ResolvedSession) {
    const people = await this.portal.people(clientId, session.account.id);
    if (!people) {
      throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
    }
    return { people: people.map((person) => ({ ...person, linkedAt: person.linkedAt.toISOString() })) };
  }

  /** Ends the person's access to this client at once. */
  @Delete(':linkId')
  @RequirePermission('portal.invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async end(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('linkId', { schema: z.uuid() }) linkId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    if ((await this.portal.end(clientId, linkId, actorFor(session, request))) === 'not_found') {
      throw new NotFoundException('No current portal access with this id for this client');
    }
  }
}
