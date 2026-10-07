import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';

interface OutboxRow {
  id: string;
  kind: string;
  status: string;
  queued_at: Date;
  not_before: Date;
  expires_at: Date;
  attempt_count: number;
  lease_id: string | null;
  leased_until: Date | null;
  key_version: number | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  completed_at: Date | null;
  failure_class: string | null;
}

describe('email outbox tables', () => {
  let db: Kysely<unknown>;
  let ownerDb: Kysely<unknown>;

  const envelope = () => ({
    kind: 'security_notice',
    deduplicationKey: randomUUID(),
    keyVersion: 1,
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.from('encrypted message'),
    authTag: Buffer.alloc(16, 2),
  });

  async function insert(executor: Kysely<unknown> = db, notBefore?: Date): Promise<OutboxRow> {
    const value = envelope();
    const result = await sql<OutboxRow>`
      insert into email_outbox (
        kind, deduplication_key, key_version, nonce, ciphertext, auth_tag, not_before
      ) values (
        ${value.kind}, ${value.deduplicationKey}, ${value.keyVersion}, ${value.nonce},
        ${value.ciphertext}, ${value.authTag}, ${notBefore ?? new Date()}
      )
      returning *
    `.execute(executor);
    return result.rows[0]!;
  }

  async function claimOwn(id: string, executor: Kysely<unknown>): Promise<OutboxRow> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await sql<OutboxRow>`select * from claim_email_outbox()`.execute(executor)).rows[0];
      if (!row) {
        break;
      }
      if (row.id === id) {
        return row;
      }
    }
    throw new Error(`The test outbox row ${id} was not claimed`);
  }

  beforeAll(() => {
    db = createDatabase<unknown>(testAppDatabaseUrl(), 2);
    ownerDb = createDatabase<unknown>(testOwnerDatabaseUrl(), 2);
  });

  afterAll(async () => {
    await ownerDb.destroy();
    await db.destroy();
  });

  it('sets identity, queue time, expiry and initial state in PostgreSQL', async () => {
    const before = new Date();
    const row = await insert();

    expect(row).toMatchObject({
      id: expect.any(String),
      kind: 'security_notice',
      status: 'pending',
      queued_at: expect.any(Date),
      expires_at: expect.any(Date),
      attempt_count: 0,
      lease_id: null,
      leased_until: null,
      completed_at: null,
      failure_class: null,
    });
    expect(row.queued_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.expires_at.getTime() - row.queued_at.getTime()).toBe(24 * 60 * 60_000);
  });

  it('permits only known message kinds and one row per deduplication key', async () => {
    const value = envelope();
    const add = (kind: string) => sql`
      insert into email_outbox (kind, deduplication_key, key_version, nonce, ciphertext, auth_tag)
      values (${kind}, ${value.deduplicationKey}, 1, ${value.nonce}, ${value.ciphertext}, ${value.authTag})
    `.execute(db);

    await add('account_invitation');
    await expect(add('account_invitation')).rejects.toThrow(/unique|duplicate/i);
    await expect(add('unknown')).rejects.toThrow(/kind|check/i);
  });

  it('does not let the app supply database-controlled state', async () => {
    const value = envelope();

    await expect(sql`
      insert into email_outbox (
        kind, deduplication_key, key_version, nonce, ciphertext, auth_tag, status
      ) values (
        ${value.kind}, ${value.deduplicationKey}, 1, ${value.nonce}, ${value.ciphertext},
        ${value.authTag}, 'sent'
      )
    `.execute(db)).rejects.toThrow(/permission denied/i);
  });

  it('overwrites database-controlled identity, times and state supplied by the owner', async () => {
    const suppliedId = randomUUID();
    const value = envelope();
    const result = await sql<OutboxRow>`
      insert into email_outbox (
        id, kind, deduplication_key, key_version, nonce, ciphertext, auth_tag,
        status, queued_at, not_before, expires_at, attempt_count, failure_class
      ) values (
        ${suppliedId}, ${value.kind}, ${value.deduplicationKey}, 1, ${value.nonce},
        ${value.ciphertext}, ${value.authTag}, 'pending',
        timestamptz '2000-01-01T00:00:00Z', timestamptz '2000-01-01T00:00:00Z',
        timestamptz '2000-01-02T00:00:00Z',
        9, 'temporary'
      )
      returning *
    `.execute(ownerDb);
    const stored = result.rows[0]!;

    expect(stored.id).not.toBe(suppliedId);
    expect(stored.queued_at.getUTCFullYear()).toBeGreaterThan(2020);
    expect(stored.expires_at.getTime() - stored.queued_at.getTime()).toBe(24 * 60 * 60_000);
    expect(stored).toMatchObject({
      status: 'pending',
      attempt_count: 0,
      lease_id: null,
      leased_until: null,
      completed_at: null,
      failure_class: null,
    });
  });

  it('claims one due row with a database lease and increasing attempt count', async () => {
    await ownerDb.transaction().execute(async (trx) => {
      const queued = await insert(trx, new Date('2000-01-01T00:00:00Z'));
      const claimed = await claimOwn(queued.id, trx);

      expect(claimed).toMatchObject({
        id: queued.id,
        status: 'pending',
        attempt_count: 1,
        lease_id: expect.any(String),
        leased_until: expect.any(Date),
      });
    });
  });

  it('skips a row claimed by another worker instead of sending it twice', async () => {
    const first = await insert(ownerDb, new Date('1999-01-01T00:00:00Z'));
    const second = await insert(ownerDb, new Date('1999-01-02T00:00:00Z'));
    let secondClaim!: Promise<OutboxRow>;
    await ownerDb.transaction().execute(async (firstTransaction) => {
      const firstClaim = await claimOwn(first.id, firstTransaction);

      secondClaim = ownerDb.transaction().execute((secondTransaction) => claimOwn(second.id, secondTransaction));
      const early = await Promise.race([
        secondClaim.then(() => 'claimed' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ]);

      expect(early).toBe('claimed');
      expect((await secondClaim).id).toBe(second.id);
      expect(firstClaim.id).toBe(first.id);
    });
  });

  it('requires the current lease before accepting an outcome', async () => {
    await ownerDb.transaction().execute(async (trx) => {
      const queued = await insert(trx, new Date('2000-01-01T00:00:00Z'));
      const claimed = await claimOwn(queued.id, trx);

      const wrong = await sql<{ accepted: boolean }>`
        select finish_email_outbox(${queued.id}, ${randomUUID()}, 'sent', null, null) as accepted
      `.execute(trx);
      expect(wrong.rows[0]?.accepted).toBe(false);

      const current = await sql<OutboxRow>`select * from email_outbox where id = ${queued.id}`.execute(trx);
      expect(current.rows[0]?.lease_id).toBe(claimed.lease_id);
    });
  });

  it('keeps encrypted payload for a retry and uses a database-set retry time', async () => {
    await ownerDb.transaction().execute(async (trx) => {
      const queued = await insert(trx, new Date('2000-01-01T00:00:00Z'));
      const claimed = await claimOwn(queued.id, trx);
      const before = new Date();

      const finished = await sql<{ accepted: boolean }>`
        select finish_email_outbox(${queued.id}, ${claimed.lease_id}, 'retry', 60, 'temporary') as accepted
      `.execute(trx);
      expect(finished.rows[0]?.accepted).toBe(true);

      const retried = (await sql<OutboxRow>`select * from email_outbox where id = ${queued.id}`.execute(trx)).rows[0]!;
      expect(retried).toMatchObject({
        status: 'pending',
        attempt_count: 1,
        lease_id: null,
        leased_until: null,
        key_version: 1,
        ciphertext: queued.ciphertext,
        failure_class: 'temporary',
      });
      expect(retried.not_before.getTime()).toBeGreaterThanOrEqual(before.getTime() + 59_000);
    });
  });

  it.each(['sent', 'discarded', 'failed'] as const)(
    'records %s as terminal and erases the encrypted payload',
    async (outcome) => {
      await ownerDb.transaction().execute(async (trx) => {
        const queued = await insert(trx, new Date('2000-01-01T00:00:00Z'));
        const claimed = await claimOwn(queued.id, trx);
        const failure = outcome === 'failed' ? 'malformed' : null;

        const finished = await sql<{ accepted: boolean }>`
          select finish_email_outbox(${queued.id}, ${claimed.lease_id}, ${outcome}, null, ${failure}) as accepted
        `.execute(trx);
        expect(finished.rows[0]?.accepted).toBe(true);

        const terminal = (await sql<OutboxRow>`select * from email_outbox where id = ${queued.id}`.execute(trx)).rows[0]!;
        expect(terminal).toMatchObject({
          status: outcome,
          lease_id: null,
          leased_until: null,
          key_version: null,
          nonce: null,
          ciphertext: null,
          auth_tag: null,
          completed_at: expect.any(Date),
          failure_class: failure,
        });
      });
    },
  );

  it('refuses direct update, deletion and truncation even by the table owner', async () => {
    const row = await insert(ownerDb, new Date(Date.now() + 60_000));

    await expect(sql`update email_outbox set status = 'sent' where id = ${row.id}`.execute(ownerDb)).rejects.toThrow(
      /cannot be altered or removed/,
    );
    await expect(sql`delete from email_outbox where id = ${row.id}`.execute(ownerDb)).rejects.toThrow(
      /cannot be altered or removed/,
    );
    await expect(sql`truncate email_outbox cascade`.execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
  });

  it('keeps the transition record insert-only', async () => {
    const changeId = await ownerDb.transaction().execute(async (trx) => {
      const queued = await insert(trx, new Date('2000-01-01T00:00:00Z'));
      const claimed = await claimOwn(queued.id, trx);
      const change = await sql<{ id: string }>`
        select id from email_outbox_changes where email_outbox_id = ${claimed.id} order by changed_at desc limit 1
      `.execute(trx);
      return change.rows[0]!.id;
    });

    await expect(sql`
      update email_outbox_changes set action = 'sent' where id = ${changeId}
    `.execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
    await expect(sql`
      delete from email_outbox_changes where id = ${changeId}
    `.execute(ownerDb)).rejects.toThrow(/cannot be altered or removed/);
  });
});
