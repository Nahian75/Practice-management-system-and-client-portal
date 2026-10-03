import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailOutbox } from './mail-outbox.js';
import type { MailMessage, Mailer } from './mailer.js';

const MESSAGE: MailMessage = {
  to: 'jane@example.com',
  subject: 'Reset your password',
  text: 'Open https://portal.example.com/reset-password#token=secret-one-time-token',
};

describe('MailOutbox', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns before the email has been sent', () => {
    let finishSending: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => (finishSending = resolve)));
    const outbox = new MailOutbox({ send } as Mailer);

    outbox.enqueue(MESSAGE);

    expect(send).toHaveBeenCalledWith(MESSAGE);
    finishSending();
  });

  it('logs a failed send without any of the message', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const outbox = new MailOutbox({ send: async () => Promise.reject(new TypeError('connection refused')) });

    outbox.enqueue(MESSAGE);
    await outbox.onApplicationShutdown();

    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('secret-one-time-token');
    expect(logged).not.toContain('jane@example.com');
  });

  it('waits for emails still being sent when the app shuts down', async () => {
    let sent = false;
    const outbox = new MailOutbox({
      send: () => new Promise<void>((resolve) => setTimeout(() => ((sent = true), resolve()), 50)),
    });

    outbox.enqueue(MESSAGE);
    await outbox.onApplicationShutdown();

    expect(sent).toBe(true);
  });
});

describe('MailOutbox.drain', () => {
  it('resolves only after every queued email has been handed over', async () => {
    const delivered: string[] = [];
    const outbox = new MailOutbox({
      send: (message) => new Promise<void>((resolve) => setTimeout(() => (delivered.push(message.to), resolve()), 30)),
    });

    outbox.enqueue({ ...MESSAGE, to: 'one@example.com' });
    outbox.enqueue({ ...MESSAGE, to: 'two@example.com' });
    await outbox.drain();

    expect(delivered.sort()).toEqual(['one@example.com', 'two@example.com']);
  });
});
