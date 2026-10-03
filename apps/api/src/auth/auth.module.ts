import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, systemClock } from '../common/time/clock.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { AccountsRepository } from './accounts/accounts.repository.js';
import { AuthController } from './auth.controller.js';
import { PasswordsModule } from './passwords/passwords.module.js';
import { SessionGuard } from './sessions/session.guard.js';
import { SessionsRepository } from './sessions/sessions.repository.js';
import { SessionsService } from './sessions/sessions.service.js';
import { SignInFailuresRepository } from './sign-in/sign-in-failures.repository.js';
import { SignInController } from './sign-in/sign-in.controller.js';
import { SignInService } from './sign-in/sign-in.service.js';
import { SecretBox } from './two-factor/secret-box.js';
import { TotpCredentialsRepository } from './two-factor/totp-credentials.repository.js';
import { TwoFactorService } from './two-factor/two-factor.service.js';

const CURRENT_KEY_VERSION = 1;

@Module({
  imports: [DatabaseModule, AuditModule, PasswordsModule],
  controllers: [AuthController, SignInController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    AccountsRepository,
    SessionsRepository,
    SessionsService,
    SessionGuard,
    SignInFailuresRepository,
    SignInService,
    {
      provide: SecretBox,
      inject: [ENV],
      useFactory: (env: Env) => new SecretBox(Buffer.from(env.TOTP_ENCRYPTION_KEY, 'base64'), CURRENT_KEY_VERSION),
    },
    TotpCredentialsRepository,
    TwoFactorService,
  ],
  exports: [SessionsService, SessionGuard, TwoFactorService],
})
export class AuthModule {}
