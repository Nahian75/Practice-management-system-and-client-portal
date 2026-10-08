import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import { MailCipher } from './mail-cipher.js';
import { MailOutbox } from './mail-outbox.js';
import type { ClaimedEmail, MailOutboxRepository, NewEmailOutbox } from './mail-outbox.repository.js';
import { InvalidMailMessageError, type MailMessage, type Mailer } from './mailer.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const ID = '0199bd34-8400-7000-8000-000000000001';
const LEASE_ID = '0199bd34-8400-7000-8000-000000000002';
const MESSAGE: MailMessage = {
  to: 'jane@example.com',
  subject: 'Reset your password',
  text: 'Open https://portal.example.com/reset-password#token=secret-one-time-token',
};

function harness(options: { send?: Mailer['send']; claim?: ClaimedEmail } = {}) {
  const cipher = new MailCipher(Buffer.alloc(32, 7), 1);
  const enqueue = vi.fn(async (_row: NewEmailOutbox) => ({ id: ID, created: true }));
  const claim = vi
    .fn<() => Promise<ClaimedEmail | undefined>>()
    .mockResolvedValueOnce(options.claim)
    .mockResolvedValue(undefined);
  const finish = vi.fn(async () => true);
  const hasDue = vi.fn(async () => false);
  const taskEmailIsCurrent = vi.fn(async () => true);
  const repository = {
    enqueue,
    claim,
    finish,
    hasDue,
    taskEmailIsCurrent,
    transaction: async <T>(work: (trx: never) => Promise<T>) => work({} as never),
  } as unknown as MailOutboxRepository;
  const send = vi.fn(options.send ?? (async () => undefined));
  const mailer = { send } as Mailer;
  const record = vi.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  const outbox = new MailOutbox(repository, cipher, mailer, audit);
  return { outbox, cipher, enqueue, claim, finish, hasDue, taskEmailIsCurrent, send, record };
}

function claimed(cipher: MailCipher, overrides: Partial<ClaimedEmail> = {}): ClaimedEmail {
  const metadata = {
    kind: overrides.kind ?? 'password_reset',
    recipientAccountId: overrides.recipientAccountId ?? '0199bd34-8400-7000-8000-000000000003',
    resourceType: overrides.resourceType ?? 'password_reset',
    resourceId: overrides.resourceId ?? '0199bd34-8400-7000-8000-000000000004',
    deduplicationKey: null,
  };
  return {
    id: ID,
    ...metadata,
    ...cipher.seal(MESSAGE, metadata),
    queuedAt: new Date(NOW.getTime() - 1_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    discardAfter: null,
    attemptCount: 1,
    leaseId: LEASE_ID,
    databaseNow: new Date(NOW),
    ...overrides,
  };
}

describe('MailOutbox.enqueue', () => {
  it('stores an encrypted envelope and records only safe audit metadata', async () => {
    const { outbox, enqueue, record } = harness();

    await outbox.enqueue(MESSAGE, {
      kind: 'password_reset',
      recipientAccountId: '0199bd34-8400-7000-8000-000000000003',
      resource: { type: 'password_reset', id: '0199bd34-8400-7000-8000-000000000004' },
      deduplicationKey: 'password-reset:0199bd34-8400-7000-8000-000000000004',
      discardAfter: new Date(NOW.getTime() + 30 * 60_000),
    });

    expect(enqueue).toHaveBeenCalledOnce();
    const stored = enqueue.mock.calls[0]![0];
    expect(stored).toMatchObject({
      kind: 'password_reset',
      recipientAccountId: expect.any(String),
      resourceType: 'password_reset',
      resourceId: expect.any(String),
      keyVersion: 1,
      nonce: expect.any(Buffer),
      ciphertext: expect.any(Buffer),
      authTag: expect.any(Buffer),
    });
    const databaseValues = JSON.stringify(stored);
    expect(databaseValues).not.toContain(MESSAGE.to);
    expect(databaseValues).not.toContain(MESSAGE.subject);
    expect(databaseValues).not.toContain('secret-one-time-token');

    const audited = JSON.stringify(record.mock.calls);
    expect(audited).toContain('email.queued');
    expect(audited).toContain(ID);
    expect(audited).not.toContain(MESSAGE.to);
    expect(audited).not.toContain(MESSAGE.subject);
    expect(audited).not.toContain('secret-one-time-token');
  });
});

describe('MailOutbox worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decrypts and sends a due message, then records success', async () => {
    const setup = harness();
    setup.claim.mockReset().mockResolvedValueOnce(claimed(setup.cipher)).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.taskEmailIsCurrent).toHaveBeenCalledWith(expect.anything(), MESSAGE.to);
    expect(setup.send).toHaveBeenCalledWith(MESSAGE);
    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, { outcome: 'sent' }, expect.anything());
    expect(JSON.stringify(setup.record.mock.calls)).toContain('email.sent');
  });

  it('uses one worker loop when drains overlap', async () => {
    const setup = harness();
    let releaseClaim: ((row: undefined) => void) | undefined;
    setup.claim.mockReset().mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        releaseClaim = resolve;
      }),
    );

    const first = setup.outbox.drain();
    const second = setup.outbox.drain();
    await vi.waitFor(() => expect(releaseClaim).toBeDefined());

    expect(setup.claim).toHaveBeenCalledOnce();
    releaseClaim!(undefined);
    await Promise.all([first, second]);
    expect(setup.claim).toHaveBeenCalledOnce();
  });

  it('stops waiting for another worker when the application shuts down', async () => {
    const setup = harness();
    setup.claim.mockReset().mockResolvedValue(undefined);
    setup.hasDue.mockResolvedValue(true);

    const draining = setup.outbox.drain();
    await vi.waitFor(() => expect(setup.hasDue).toHaveBeenCalled());

    await setup.outbox.onApplicationShutdown();
    await draining;
  });

  it('fails a corrupted encrypted payload without sending or retrying', async () => {
    const setup = harness();
    const row = claimed(setup.cipher);
    row.authTag = Buffer.alloc(16, 99);
    setup.claim.mockReset().mockResolvedValueOnce(row).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.send).not.toHaveBeenCalled();
    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, {
      outcome: 'failed',
      failureClass: 'invalid_payload',
    }, expect.anything());
  });

  it('fails malformed mail without retrying', async () => {
    const setup = harness({ send: async () => Promise.reject(new InvalidMailMessageError('bad message')) });
    setup.claim.mockReset().mockResolvedValueOnce(claimed(setup.cipher)).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, {
      outcome: 'failed',
      failureClass: 'malformed',
    }, expect.anything());
  });

  it('retries a temporary fault and logs no message or provider error text', async () => {
    const logWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const providerText = 'connection refused for jane@example.com secret-one-time-token';
    const setup = harness({ send: async () => Promise.reject(new Error(providerText)) });
    setup.claim.mockReset().mockResolvedValueOnce(claimed(setup.cipher)).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, {
      outcome: 'retry',
      retryAfterSeconds: 60,
      failureClass: 'temporary',
    }, expect.anything());
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).toContain(ID);
    expect(logged).not.toContain(providerText);
    expect(logged).not.toContain(MESSAGE.to);
    expect(logged).not.toContain('secret-one-time-token');
  });

  it('fails a permanent SMTP refusal without storing its response', async () => {
    const refusal = Object.assign(new Error('550 jane@example.com rejected'), { responseCode: 550 });
    const setup = harness({ send: async () => Promise.reject(refusal) });
    setup.claim.mockReset().mockResolvedValueOnce(claimed(setup.cipher)).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, {
      outcome: 'failed',
      failureClass: 'provider_rejected',
    }, expect.anything());
  });

  it('discards a message whose one-time link has expired', async () => {
    const setup = harness();
    setup.claim
      .mockReset()
      .mockResolvedValueOnce(claimed(setup.cipher, { discardAfter: new Date(NOW.getTime() - 1) }))
      .mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.send).not.toHaveBeenCalled();
    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, { outcome: 'discarded' }, expect.anything());
  });

  it('discards a stale task email immediately before delivery', async () => {
    const setup = harness();
    setup.taskEmailIsCurrent.mockResolvedValue(false);
    setup.claim.mockReset().mockResolvedValueOnce(claimed(setup.cipher, {
      kind: 'task_reminder',
      resourceType: 'task',
      deduplicationKey: 'task-email:reminder:0199bd34-8400-7000-8000-000000000004:2026-10-08:today:0199bd34-8400-7000-8000-000000000003',
    })).mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.taskEmailIsCurrent).toHaveBeenCalledOnce();
    expect(setup.send).not.toHaveBeenCalled();
    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, { outcome: 'discarded' }, expect.anything());
  });

  it('fails a message after the final 24-hour limit', async () => {
    const setup = harness();
    setup.claim
      .mockReset()
      .mockResolvedValueOnce(claimed(setup.cipher, { expiresAt: new Date(NOW.getTime() - 1) }))
      .mockResolvedValue(undefined);

    await setup.outbox.drain();

    expect(setup.send).not.toHaveBeenCalled();
    expect(setup.finish).toHaveBeenCalledWith(ID, LEASE_ID, {
      outcome: 'failed',
      failureClass: 'delivery_expired',
    }, expect.anything());
  });
});
