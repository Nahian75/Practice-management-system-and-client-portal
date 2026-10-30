import {keyParameters} from '../common/crypto/key-ring.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { MailCipher } from './mail-cipher.js';
import { MailOutbox } from './mail-outbox.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { MAILER, SmtpMailer } from './mailer.js';



@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [
    { provide: MAILER, useClass: SmtpMailer },
    {
      provide: MailCipher,
      inject: [ENV],
      useFactory: (env: Env) =>
        new MailCipher(...keyParameters(env, 'MAIL')),
    },
    MailOutboxRepository,
    MailOutbox,
  ],
  exports: [MAILER, MailOutbox],
})
export class MailModule {}
