import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContext } from '../../common/http/request-context.js';
import { ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { Public } from '../sessions/access.decorators.js';
import { readSessionToken, setSessionCookie } from '../sessions/session-cookie.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SignInService } from './sign-in.service.js';
import { RETRY_AFTER_SECONDS, TooManyAttemptsException } from './too-many-attempts.exception.js';

// No format rules beyond size: a malformed email should get the same answer
// as a wrong password, not a different error that reveals the check.
const signInSchema = z.strictObject({
  email: z.string().max(254),
  password: z.string().min(1).max(1024),
});

const signInResponseSchema = z.object({
  next: z.literal('two_factor'),
});

export const SIGN_IN_REJECTED_MESSAGE = 'Email or password is incorrect';

@Controller('auth')
export class SignInController {
  constructor(
    private readonly signIns: SignInService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('sign-in')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(signInResponseSchema)
  async signIn(
    @Body({ schema: signInSchema }) body: z.infer<typeof signInSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.infer<typeof signInResponseSchema>> {
    const context = requestContext(request);

    // A new sign-in always starts from a fresh session.
    await this.sessions.signOut(readSessionToken(request), context);

    const result = await this.signIns.signIn(body.email, body.password, context);
    if (result.outcome === 'rate_limited') {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
      throw new TooManyAttemptsException();
    }
    if (result.outcome === 'rejected') {
      throw new UnauthorizedException(SIGN_IN_REJECTED_MESSAGE);
    }

    setSessionCookie(response, result.token);
    return { next: 'two_factor' };
  }
}
