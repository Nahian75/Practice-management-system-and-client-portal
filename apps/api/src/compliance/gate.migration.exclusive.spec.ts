import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestAccount } from '../../test/accounts.js';
import {
  clearMatterForTests, createAmlStaff, createTeamMatter, decideTestClearance, ensureAmlFramework,
  grantTestStartException, imposeTestHold, liftTestHold, londonDates, submitTestAssessment,
} from '../../test/aml.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database } from '../database/schema.js';

const ACTIONS = ['time', 'documents', 'billing', 'money'] as const;
type Action = typeof ACTIONS[number];

describe('compliance gate enforcement', () => {
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let today: string;

  /** The gate decision itself, asked as the owner because the function is not granted to the app. */
  async function allowed(matterId: string): Promise<Record<Action, boolean>> {
    const result = {} as Record<Action, boolean>;
    for (const action of ACTIONS) {
      result[action] = await owner.transaction().execute((trx) =>
        sql`select app.assert_aml_gate(${matterId}, ${action})`.execute(trx)).then(() => true, (error: { code?: string }) => {
        if (error.code !== '23514') throw error;
        return false;
      });
    }
    return result;
  }
  const none = { time: false, documents: false, billing: false, money: false };
  const all = { time: true, documents: true, billing: true, money: true };
  const addDay = async (days: number) => (await sql<{ day: string }>`select (${today}::date + ${days}::integer)::text as day`.execute(db)).rows[0]!.day;

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 4);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    ({ today } = await londonDates(db));
    await ensureAmlFramework(db);
  });
  afterAll(async () => {
    await owner.destroy();
    await db.destroy();
  });
  beforeEach(async () => {
    partner = await createAmlStaff(db, 'partner');
    feeEarner = await createAmlStaff(db, 'fee_earner');
    compliance = await createAmlStaff(db, 'compliance');
  });

  it('installs the gate on every gated table', async () => {
    const tables = (await sql<{ table: string }>`select c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = 'zz_aml_gate' order by 1`.execute(owner)).rows.map((row) => row.table);
    expect(tables).toEqual(['bill_drafts', 'client_payment_events', 'client_payment_requests', 'document_versions', 'documents',
      'finance_transactions', 'issued_bills', 'time_entries']);
  });

  it('blocks all gated work while pending and allows it once cleared', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    expect(await allowed(matterId)).toEqual(none);
    await expect(db.insertInto('documents').values({ matter_id: matterId, title: 'Draft', category: 'other', created_by: feeEarner.id })
      .execute()).rejects.toMatchObject({ code: '23514', message: 'compliance clearance is required for this action' });


    await clearMatterForTests(db, matterId);
    expect(await allowed(matterId)).toEqual(all);
    await expect(db.transaction().execute(async (trx) => {
      const document = await trx.insertInto('documents').values({ matter_id: matterId, title: 'Draft', category: 'other', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('document_versions').values({
        document_id: document.id, file_name: 'draft.pdf', media_type: 'application/pdf', size_bytes: 10, sha256: Buffer.alloc(32, 1),
        storage_key: randomUUID(), key_version: 1, key_nonce: Buffer.alloc(12), wrapped_key: Buffer.alloc(32), key_tag: Buffer.alloc(16),
        uploaded_by: feeEarner.id,
      }).execute();
    })).resolves.toBeUndefined();
  });

  it('blocks everything under a matter or client hold until it is lifted', async () => {
    const { matterId, clientId } = await createTeamMatter(db, feeEarner, partner);
    await clearMatterForTests(db, matterId);
    const matterHold = await imposeTestHold(db, { matterId }, compliance.id);
    expect(await allowed(matterId)).toEqual(none);
    await liftTestHold(db, matterHold, compliance.id);
    expect(await allowed(matterId)).toEqual(all);

    const clientHold = await imposeTestHold(db, { clientId }, compliance.id);
    expect(await allowed(matterId)).toEqual(none);
    await expect(liftTestHold(db, clientHold, feeEarner.id)).rejects.toMatchObject({ code: '42501' });
    await liftTestHold(db, clientHold, compliance.id);
    await expect(liftTestHold(db, clientHold, compliance.id)).rejects.toMatchObject({ code: '23505' });
    expect(await allowed(matterId)).toEqual(all);
    await expect(imposeTestHold(db, { matterId }, partner.id)).rejects.toMatchObject({ code: '42501' });
  });

  it('blocks money at once when review falls due and other work after the grace period', async () => {
    const graced = await createTeamMatter(db, feeEarner, partner);
    const assessment = await submitTestAssessment(db, graced.matterId, compliance.id, { graceDays: 14 });
    await decideTestClearance(db, assessment, (await createAmlStaff(db, 'compliance')).id);
    await db.updateTable('client_individuals').set({ town: 'York' }).where('client_id', '=', graced.clientId).execute();
    expect(await allowed(graced.matterId)).toEqual({ time: true, documents: true, billing: true, money: false });

    const strict = await createTeamMatter(db, feeEarner, partner);
    const noGrace = await submitTestAssessment(db, strict.matterId, compliance.id, { graceDays: 0 });
    await decideTestClearance(db, noGrace, (await createAmlStaff(db, 'compliance')).id);
    await db.updateTable('client_individuals').set({ town: 'York' }).where('client_id', '=', strict.clientId).execute();
    expect(await allowed(strict.matterId)).toEqual(none);
  });

  it('lets an approved early-start exception allow only its actions, never money', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const assessment = await submitTestAssessment(db, matterId, feeEarner.id);
    const exceptionId = await grantTestStartException(db, assessment, compliance.id, ['time'], await addDay(7));
    expect(await allowed(matterId)).toEqual(none);

    await expect(sql`select app.approve_aml_start_exception(${exceptionId}, ${feeEarner.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
    const both = await createAmlStaff(db, 'partner', 'compliance');
    const ownGrant = await grantTestStartException(db, assessment, both.id, ['documents'], await addDay(7));
    await expect(sql`select app.approve_aml_start_exception(${ownGrant}, ${both.id})`.execute(db)).rejects.toMatchObject({ code: '23514' });
    await sql`select app.approve_aml_start_exception(${exceptionId}, ${partner.id})`.execute(db);
    expect(await allowed(matterId)).toEqual({ time: true, documents: false, billing: false, money: false });

    await submitTestAssessment(db, matterId, feeEarner.id);
    expect((await allowed(matterId)).time).toBe(false);
  });

  it('refuses an early start for high risk, by the preparer, beyond 30 days, for money or under a hold', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const high = await submitTestAssessment(db, matterId, feeEarner.id, { rating: 'high' });
    await expect(grantTestStartException(db, high, compliance.id, ['time'], await addDay(7))).rejects.toMatchObject({ code: '23514' });

    const standard = await submitTestAssessment(db, matterId, compliance.id, { loweringGrounds: true });
    await expect(grantTestStartException(db, standard, compliance.id, ['time'], await addDay(7))).rejects.toMatchObject({ code: '23514' });
    const other = await createAmlStaff(db, 'compliance');
    await expect(grantTestStartException(db, standard, other.id, ['time'], await addDay(31))).rejects.toMatchObject({ code: '23514' });
    await expect(grantTestStartException(db, standard, other.id, ['money' as 'time'], await addDay(7))).rejects.toMatchObject({ code: '23514' });

    await imposeTestHold(db, { matterId }, other.id);
    await expect(grantTestStartException(db, standard, other.id, ['time'], await addDay(7))).rejects.toMatchObject({ code: '23514' });
  });

  it('queues pending, held and due matters for Compliance', async () => {
    const pending = await createTeamMatter(db, feeEarner, partner);
    await submitTestAssessment(db, pending.matterId, feeEarner.id);
    const held = await createTeamMatter(db, feeEarner, partner);
    await clearMatterForTests(db, held.matterId);
    await imposeTestHold(db, { matterId: held.matterId }, compliance.id);
    const cleared = await createTeamMatter(db, feeEarner, partner);
    await clearMatterForTests(db, cleared.matterId);

    const queue = (await sql<{ matter_id: string; state: string }>`select matter_id, state from app.aml_review_queue(200)`.execute(db)).rows;
    expect(queue.find((row) => row.matter_id === pending.matterId)?.state).toBe('pending');
    expect(queue.find((row) => row.matter_id === held.matterId)?.state).toBe('held');
    expect(queue.some((row) => row.matter_id === cleared.matterId)).toBe(false);
  });

  it('keeps holds, lifts and exceptions immutable and refuses direct writes', async () => {
    const { matterId } = await createTeamMatter(db, feeEarner, partner);
    const holdId = await imposeTestHold(db, { matterId }, compliance.id);
    await expect(owner.deleteFrom('aml_holds').where('id', '=', holdId).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(sql`insert into app.aml_hold_lifts(id, hold_id, encryption_context, key_version, nonce, ciphertext, auth_tag, lifted_by)
      values (${randomUUID()}, ${holdId}, 'x', 1, ${Buffer.alloc(12)}, ${Buffer.alloc(2)}, ${Buffer.alloc(16)}, ${compliance.id})`
      .execute(owner)).rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_start_exceptions cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
  });
});
