import { secretBoxFor } from '../common/crypto/key-ring.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SecretBox } from '../common/crypto/secret-box.js';
import { CLOCK, systemClock } from '../common/time/clock.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { AccountsRepository } from './accounts/accounts.repository.js';
import { AuthController } from './auth.controller.js';
import { InvitationsController } from './invitations/invitations.controller.js';
import { InvitationsRepository } from './invitations/invitations.repository.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { SecurityNoticesService } from './notices/security-notices.service.js';
import { PasswordResetController } from './password-reset/password-reset.controller.js';
import { PasswordResetService } from './password-reset/password-reset.service.js';
import { PasswordResetsRepository } from './password-reset/password-resets.repository.js';
import { PasswordsModule } from './passwords/passwords.module.js';
import { PermissionGuard } from './permissions/permission.guard.js';
import { PermissionsService } from './permissions/permissions.service.js';
import { RolesRepository } from './permissions/roles.repository.js';
import { RolesService } from './permissions/roles.service.js';
import { SessionGuard } from './sessions/session.guard.js';
import { SessionsRepository } from './sessions/sessions.repository.js';
import { SessionsService } from './sessions/sessions.service.js';
import { SignInFailuresRepository } from './sign-in/sign-in-failures.repository.js';
import { SignInController } from './sign-in/sign-in.controller.js';
import { SignInLimits } from './sign-in/sign-in-limits.js';
import { SignInService } from './sign-in/sign-in.service.js';
import { BackupCodesRepository } from './two-factor/backup-codes.repository.js';
import { BackupCodesService } from './two-factor/backup-codes.service.js';
import { TotpCredentialsRepository } from './two-factor/totp-credentials.repository.js';
import { TwoFactorSignInController } from './two-factor/two-factor-sign-in.controller.js';
import { TwoFactorSignInService } from './two-factor/two-factor-sign-in.service.js';
import { TwoFactorService } from './two-factor/two-factor.service.js';
import { SecurityRetentionService } from './retention/security-retention.service.js';


@Module({
  imports: [DatabaseModule, AuditModule, PasswordsModule, MailModule],
  controllers: [
    AuthController,
    SignInController,
    TwoFactorSignInController,
    InvitationsController,
    PasswordResetController,
  ],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    AccountsRepository,
    SessionsRepository,
    SessionsService,
    SessionGuard,
    SignInFailuresRepository,
    SignInLimits,
    SignInService,
    {
      provide: SecretBox,
      inject: [ENV],
      useFactory: (env: Env) => secretBoxFor(env, 'TOTP'),
    },
    TotpCredentialsRepository,
    TwoFactorService,
    BackupCodesRepository,
    BackupCodesService,
    TwoFactorSignInService,
    InvitationsRepository,
    InvitationsService,
    SecurityNoticesService,
    PasswordResetsRepository,
    PasswordResetService,
    RolesRepository,
    RolesService,
    PermissionsService,
    PermissionGuard,
    SecurityRetentionService,
  ],
  exports: [
    SessionsService,
    SessionGuard,
    PermissionGuard,
    PermissionsService,
    RolesRepository,
    RolesService,
    TwoFactorService,
    BackupCodesService,
    InvitationsRepository,
    CLOCK,
    InvitationsService,
    SecurityNoticesService,
    SecurityRetentionService,
  ],
})
export class AuthModule {}
