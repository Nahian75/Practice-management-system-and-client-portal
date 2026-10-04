import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import { z } from 'zod';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only: no HTML means nothing in an email can be rendered as markup. */
  text: string;
}

export const MAILER = Symbol('MAILER');

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class InvalidMailMessageError extends Error {
  override readonly name = 'InvalidMailMessageError';
}

const DEFAULT_SMTPS_PORT = 465;
const DEFAULT_SMTP_PORT = 587;
// Emails share a few open connections and queue for them, so a burst (one
// notice per compliance holder) does not open a connection per message.
const MAX_SMTP_CONNECTIONS = 3;

// A recipient or subject containing a line break could add headers such as Bcc.
const singleLine = z.string().regex(/^[^\r\n]*$/);
const messageSchema = z.object({
  to: z.email(),
  subject: singleLine.min(1).max(200),
  text: z.string().min(1),
});

/** Kept separate from the class so the security-relevant settings can be tested directly. */
export function smtpTransportOptions(env: Pick<Env, 'NODE_ENV' | 'SMTP_URL'>): SMTPPool.Options {
  const url = new URL(env.SMTP_URL);
  const implicitTls = url.protocol === 'smtps:';

  return {
    host: url.hostname,
    port: Number(url.port) || (implicitTls ? DEFAULT_SMTPS_PORT : DEFAULT_SMTP_PORT),
    pool: true,
    maxConnections: MAX_SMTP_CONNECTIONS,
    secure: implicitTls,
    // In production, refuse to send over a connection that did not upgrade to TLS.
    requireTLS: env.NODE_ENV === 'production' && !implicitTls,
    ...(url.username
      ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }
      : {}),
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

@Injectable()
export class SmtpMailer implements Mailer, OnApplicationShutdown {
  private readonly transport: Transporter<SMTPPool.SentMessageInfo>;
  private readonly from: { name: string; address: string };

  constructor(@Inject(ENV) env: Env) {
    this.transport = createTransport(smtpTransportOptions(env));
    this.from = { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM_ADDRESS };
  }

  async send(message: MailMessage): Promise<void> {
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success) {
      // The message is not logged: email bodies can carry one-time links.
      throw new InvalidMailMessageError('Refusing to send a malformed email');
    }
    await this.transport.sendMail({ from: this.from, ...parsed.data });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
