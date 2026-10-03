import { Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { AnyAccount, Public } from './sessions/access.decorators.js';
import { CurrentSession, type ResolvedSession } from './sessions/authenticated-session.js';
import { clearSessionCookie, readSessionToken } from './sessions/session-cookie.js';
import { SessionsService } from './sessions/sessions.service.js';

const currentSessionSchema = z.object({
  account: z.object({
    id: z.uuid(),
    kind: z.enum(['staff', 'client']),
    displayName: z.string(),
  }),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('sign-out')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async signOut(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.signOut(readSessionToken(request), requestContext(request));
    clearSessionCookie(response);
  }

  @Get('session')
  @AnyAccount()
  @ResponseSchema(currentSessionSchema)
  current(@CurrentSession() session: ResolvedSession): z.infer<typeof currentSessionSchema> {
    return { account: session.account };
  }
}
