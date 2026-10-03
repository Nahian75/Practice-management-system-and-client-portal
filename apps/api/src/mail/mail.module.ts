import { Module } from '@nestjs/common';
import { MailOutbox } from './mail-outbox.js';
import { MAILER, SmtpMailer } from './mailer.js';

@Module({
  providers: [{ provide: MAILER, useClass: SmtpMailer }, MailOutbox],
  exports: [MAILER, MailOutbox],
})
export class MailModule {}
