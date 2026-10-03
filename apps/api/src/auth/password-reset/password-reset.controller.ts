import { BadRequestException, Body, Controller, HttpCode, HttpStatus, NotFoundException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { OPAQUE_TOKEN_PATTERN } from '../../common/crypto/opaque-token.js';
import { requestContext } from '../../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { PASSWORD_PROBLEM_MESSAGES } from '../passwords/password-problem-messages.js';
import { Public } from '../sessions/access.decorators.js';
import { PasswordResetService } from './password-reset.service.js';

// No email format check: a malformed address gets the same answer as any other.
const requestSchema = z.strictObject({ email: z.string().max(254) });
const completeSchema = z.strictObject({
  token: z.string().regex(OPAQUE_TOKEN_PATTERN),
  password: z.string().min(1).max(1024),
});

export const INVALID_RESET_LINK_MESSAGE = 'This reset link is invalid or has expired';

@Controller('auth/password-reset')
@Public()
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Post('request')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async request(@Body({ schema: requestSchema }) body: z.infer<typeof requestSchema>, @Req() request: Request) {
    await this.passwordReset.request(body.email, requestContext(request));
  }

  @Post('complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async complete(@Body({ schema: completeSchema }) body: z.infer<typeof completeSchema>, @Req() request: Request) {
    const result = await this.passwordReset.complete(body.token, body.password, requestContext(request));
    switch (result.outcome) {
      case 'invalid_link':
        throw new NotFoundException(INVALID_RESET_LINK_MESSAGE);
      case 'rejected':
        throw new BadRequestException(result.problems.map((problem) => PASSWORD_PROBLEM_MESSAGES[problem]));
      case 'completed':
        return;
    }
  }
}
