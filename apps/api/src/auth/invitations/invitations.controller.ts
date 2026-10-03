import { BadRequestException, Body, Controller, HttpCode, HttpStatus, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { OPAQUE_TOKEN_PATTERN } from '../../common/crypto/opaque-token.js';
import { ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { PASSWORD_PROBLEM_MESSAGES } from '../passwords/password-problem-messages.js';
import { Public } from '../sessions/access.decorators.js';
import { InvitationsService } from './invitations.service.js';

const token = z.string().regex(OPAQUE_TOKEN_PATTERN);

const inspectSchema = z.strictObject({ token });
const setPasswordSchema = z.strictObject({ token, password: z.string().min(1).max(1024) });
const completeSchema = z.strictObject({ token, code: z.string().min(6).max(32) });

const invitationSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  kind: z.enum(['staff', 'client']),
});
const twoFactorSetupSchema = z.object({
  twoFactor: z.object({ secret: z.string(), uri: z.string() }).nullable(),
});
const completedSchema = z.object({
  backupCodes: z.array(z.string()).length(10),
});

export const INVALID_INVITATION_MESSAGE = 'This invitation link is invalid or has expired';

/**
 * Accepting an invitation. Public because the person has no account yet; each
 * call must carry the 256-bit token from the invitation email.
 */
@Controller('auth/invitations')
@Public()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('inspect')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(invitationSchema)
  async inspect(@Body({ schema: inspectSchema }) body: z.infer<typeof inspectSchema>) {
    const invitation = await this.invitations.inspect(body.token);
    if (!invitation) {
      throw new NotFoundException(INVALID_INVITATION_MESSAGE);
    }
    return invitation;
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(twoFactorSetupSchema)
  async setPassword(@Body({ schema: setPasswordSchema }) body: z.infer<typeof setPasswordSchema>) {
    const result = await this.invitations.setPassword(body.token, body.password);
    switch (result.outcome) {
      case 'invalid_invitation':
        throw new NotFoundException(INVALID_INVITATION_MESSAGE);
      case 'rejected':
        throw new BadRequestException(result.problems.map((problem) => PASSWORD_PROBLEM_MESSAGES[problem]));
      case 'accepted':
        return { twoFactor: result.twoFactor };
    }
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(completedSchema)
  async complete(@Body({ schema: completeSchema }) body: z.infer<typeof completeSchema>) {
    const result = await this.invitations.complete(body.token, body.code);
    switch (result.outcome) {
      case 'invalid_invitation':
        throw new NotFoundException(INVALID_INVITATION_MESSAGE);
      case 'password_required':
        throw new BadRequestException('Choose a password first');
      case 'wrong_code':
        throw new BadRequestException('The code is incorrect');
      case 'completed':
        return { backupCodes: result.backupCodes };
    }
  }
}
