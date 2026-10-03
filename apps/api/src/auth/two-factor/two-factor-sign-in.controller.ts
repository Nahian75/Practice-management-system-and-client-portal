import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContext } from '../../common/http/request-context.js';
import { ResponseSchema } from '../../common/serialization/response-schema.decorator.js';
import { Public } from '../sessions/access.decorators.js';
import { clearSessionCookie, readSessionToken, setSessionCookie } from '../sessions/session-cookie.js';
import { RETRY_AFTER_SECONDS, TooManyAttemptsException } from '../sign-in/too-many-attempts.exception.js';
import { TwoFactorSignInService } from './two-factor-sign-in.service.js';

const twoFactorSchema = z.strictObject({
  code: z.string().min(6).max(32),
});

const signedInSchema = z.object({
  account: z.object({
    id: z.uuid(),
    kind: z.enum(['staff', 'client']),
    displayName: z.string(),
  }),
});

export const WRONG_CODE_MESSAGE = 'The code is incorrect';
export const SIGN_IN_AGAIN_MESSAGE = 'Please sign in again';

@Controller('auth')
export class TwoFactorSignInController {
  constructor(private readonly twoFactorSignIn: TwoFactorSignInService) {}

  // Public because the session it receives is not signed in yet; the service
  // only accepts one that has just passed the password step.
  @Post('two-factor')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ResponseSchema(signedInSchema)
  async complete(
    @Body({ schema: twoFactorSchema }) body: z.infer<typeof twoFactorSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<z.infer<typeof signedInSchema>> {
    const result = await this.twoFactorSignIn.complete(readSessionToken(request), body.code, requestContext(request));

    switch (result.outcome) {
      case 'signed_in':
        setSessionCookie(response, result.token);
        return { account: result.account };
      case 'wrong_code':
        throw new UnauthorizedException(WRONG_CODE_MESSAGE);
      case 'rate_limited':
        response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
        throw new TooManyAttemptsException();
      case 'sign_in_again':
        clearSessionCookie(response);
        throw new UnauthorizedException(SIGN_IN_AGAIN_MESSAGE);
    }
  }
}
