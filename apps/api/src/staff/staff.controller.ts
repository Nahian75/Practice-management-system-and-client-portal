import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { STAFF_ROLES } from '../auth/permissions/permissions.js';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import type { LastHolderRefusal } from '../auth/permissions/roles.service.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { StaffService, type StaffActor } from './staff.service.js';

const accountId = z.uuid();
const role = z.enum(STAFF_ROLES);

const inviteSchema = z.strictObject({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(200),
});

const staffListSchema = z.object({
  staff: z.array(
    z.object({
      id: z.uuid(),
      email: z.string(),
      displayName: z.string(),
      status: z.enum(['invited', 'active', 'disabled']),
      roles: z.array(role),
    }),
  ),
});
const invitedSchema = z.object({
  accountId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
const enabledSchema = z.object({
  expiresAt: z.iso.datetime(),
});

export const STAFF_NOT_FOUND_MESSAGE = 'No staff account with this id';
export const OWN_ACCOUNT_MESSAGE = 'You cannot change your own account';
export const LAST_HOLDER_MESSAGES: Readonly<Record<LastHolderRefusal, string>> = {
  last_administrator: 'The firm must keep at least one active administrator',
  last_compliance: 'The firm must keep at least one active compliance holder',
  last_nominated_officer: 'The firm must keep at least one active nominated officer',
};

function actorFor(session: ResolvedSession, request: Request): StaffActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermission('staff.view')
  @ResponseSchema(staffListSchema)
  async list() {
    return { staff: await this.staff.list() };
  }

  @Post('invitations')
  @RequirePermission('staff.invite')
  @ResponseSchema(invitedSchema)
  async invite(
    @Body({ schema: inviteSchema }) body: z.infer<typeof inviteSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.staff.invite(body, actorFor(session, request));
    if (result.outcome === 'not_invitable') {
      throw new ConflictException('An account with this email address already exists');
    }
    return { accountId: result.accountId, expiresAt: result.expiresAt.toISOString() };
  }

  @Put(':accountId/roles/:role')
  @RequirePermission('staff.roles.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async grantRole(
    @Param('accountId', { schema: accountId }) id: string,
    @Param('role', { schema: role }) grantedRole: z.infer<typeof role>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    switch (await this.staff.grantRole(id, grantedRole, actorFor(session, request))) {
      case 'not_found':
        throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      case 'own_account':
        throw new ForbiddenException(OWN_ACCOUNT_MESSAGE);
      case 'disabled':
        throw new ConflictException('This account is disabled');
      case 'granted':
        return;
    }
  }

  @Delete(':accountId/roles/:role')
  @RequirePermission('staff.roles.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async revokeRole(
    @Param('accountId', { schema: accountId }) id: string,
    @Param('role', { schema: role }) revokedRole: z.infer<typeof role>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    const result = await this.staff.revokeRole(id, revokedRole, actorFor(session, request));
    switch (result) {
      case 'not_found':
        throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      case 'own_account':
        throw new ForbiddenException(OWN_ACCOUNT_MESSAGE);
      case 'last_administrator':
      case 'last_compliance':
      case 'last_nominated_officer':
        throw new ConflictException(LAST_HOLDER_MESSAGES[result]);
      case 'revoked':
      case 'not_held':
        return;
    }
  }

  @Post(':accountId/disable')
  @RequirePermission('staff.disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async disable(
    @Param('accountId', { schema: accountId }) id: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    const result = await this.staff.disable(id, actorFor(session, request));
    switch (result) {
      case 'not_found':
        throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      case 'own_account':
        throw new ForbiddenException(OWN_ACCOUNT_MESSAGE);
      case 'last_administrator':
      case 'last_compliance':
      case 'last_nominated_officer':
        throw new ConflictException(LAST_HOLDER_MESSAGES[result]);
      case 'disabled':
      case 'already_disabled':
        return;
    }
  }

  @Post(':accountId/enable')
  @RequirePermission('staff.disable')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(enabledSchema)
  async enable(
    @Param('accountId', { schema: accountId }) id: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.staff.enable(id, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);
      case 'own_account':
        throw new ForbiddenException(OWN_ACCOUNT_MESSAGE);
      case 'not_disabled':
        throw new ConflictException('This account is not disabled');
      case 'enabled':
        return { expiresAt: result.expiresAt.toISOString() };
    }
  }
}
