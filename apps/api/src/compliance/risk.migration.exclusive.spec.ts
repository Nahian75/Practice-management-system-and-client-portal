import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

const CONTROL_KINDS = ['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy'];
/** A user-assigned ISO code, so no real country is treated as high risk by a test. */
const LISTED = 'QZ';

describe('risk assessment database rules', () => {
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let partner: TestAccount;
  let feeEarner: TestAccount;
  let compliance: TestAccount;
  let today: string;
  let inAYear: string;

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  /** An open individual matter whose team is the fee earner and supervising partner. */
  async function matter() {
    return db.transaction().execute(async (trx) => {
      const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_individuals').values({
        client_id: client.id, given_names: randomUUID(), family_name: randomUUID(), date_of_birth: '1980-01-02',
        address_line1: '1 Test Street', town: 'London', postcode: 'SW1A 1AA', country: 'GB',
      }).execute();
      const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [randomUUID()] })
        .returning('id').executeTakeFirstOrThrow();
      const created = await trx.insertInto('matters').values({ client_id: client.id, title: 'Risk', matter_type: 'other',
        opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('matter_team').values([
        { matter_id: created.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
        { matter_id: created.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
      ]).execute();
      return { matterId: created.id, clientId: client.id };
    });
  }

  const sealed = (context: string) => ({
    context, key: 1, nonce: Buffer.alloc(12, 1), ciphertext: Buffer.from('{}'), tag: Buffer.alloc(16, 2),
  });

  /** Gives the client a submitted CDD case, which in-scope work relies on. */
  async function submittedCdd(clientId: string) {
    const caseId = (await sql<{ id: string }>`select app.create_aml_cdd_case(
      ${clientId}, 'Ongoing legal services for the client', 'CDD before accepting the instructions', ${compliance.id}
    ) as id`.execute(db)).rows[0]!.id;
    const evidenceId = randomUUID();
    const evidence = sealed(`aml-evidence-metadata:${evidenceId}`);
    await sql`select app.add_aml_cdd_evidence(
      ${evidenceId}, ${caseId}, 'passport', 'GB'::char(2), '2020-01-01'::date, '2099-01-01'::date,
      ${evidence.context}, ${evidence.key}::smallint, ${evidence.nonce}, ${evidence.ciphertext}, ${evidence.tag},
      'application/pdf', 10, ${Buffer.alloc(32, 3)}, ${`compliance/${randomUUID()}`},
      1::smallint, ${Buffer.alloc(12, 4)}, ${Buffer.alloc(32, 5)}, ${Buffer.alloc(16, 6)}, ${compliance.id}
    )`.execute(db);
    const subjectId = randomUUID();
    const subject = sealed(`aml-subject:${subjectId}`);
    await sql`select app.add_aml_cdd_subject(
      ${subjectId}, ${caseId}, 'individual', 'client',
      ${subject.context}, ${subject.key}::smallint, ${subject.nonce}, ${subject.ciphertext}, ${subject.tag}, ${compliance.id}
    )`.execute(db);
    const verificationId = randomUUID();
    const verification = sealed(`aml-verification:${verificationId}`);
    await sql`select app.add_aml_cdd_verification(
      ${verificationId}, ${caseId}, ${subjectId}, ${evidenceId}, 'Passport', 'GB'::char(2),
      ${today}::date, '2099-01-01'::date, 'in_person', 'verified', null, null,
      ${verification.context}, ${verification.key}::smallint, ${verification.nonce}, ${verification.ciphertext},
      ${verification.tag}, ${compliance.id}
    )`.execute(db);
    await sql`select app.submit_aml_cdd_case(${caseId}, ${compliance.id})`.execute(db);
    return caseId;
  }

  interface Submission {
    inScope?: boolean; rating?: string; pep?: boolean; unusual?: boolean; jurisdictions?: string[];
    reviewDueOn?: string; loweringGrounds?: boolean; context?: string; actorId?: string;
  }

  function submit(matterId: string, options: Submission = {}, executor: Kysely<Database> = db) {
    const id = randomUUID();
    const x = sealed(options.context ?? `aml-risk:${id}`);
    const query = sql`select app.submit_aml_risk_assessment(
      ${id}, ${matterId}, ${options.inScope ?? false}, ${options.rating ?? 'standard'},
      ${options.pep ?? false}, ${options.unusual ?? false}, false, false, false, false, false, false,
      ${options.jurisdictions ?? ['GB']}::text[], 'under_10k', ${options.reviewDueOn ?? inAYear}::date, 30::smallint,
      ${options.loweringGrounds ?? false},
      ${x.context}, ${x.key}::smallint, ${x.nonce}, ${x.ciphertext}, ${x.tag}, ${options.actorId ?? feeEarner.id}
    )`;
    return query.execute(executor).then(() => id);
  }

  const assessment = (id: string) => db.selectFrom('aml_risk_assessments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  async function approvedList(countries: string[]) {
    const id = (await sql<{ id: string }>`select app.create_aml_country_list(
      ${countries}::text[], 'FATF call for action, test copy', ${today}::date, ${compliance.id}
    ) as id`.execute(db)).rows[0]!.id;
    await sql`select app.approve_aml_country_list(${id}, ${partner.id})`.execute(db);
    return id;
  }

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 4);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    ({ today, inAYear } = (await sql<{ today: string; inAYear: string }>`select app.london_today()::text as today,
      (app.london_today() + 365)::text as "inAYear"`.execute(db)).rows[0]!);
    const preparer = await staffWith('compliance');
    const approver = await staffWith('partner');
    for (const kind of CONTROL_KINDS) {
      const content = `Risk test ${kind} ${randomUUID()}`;
      const id = (await sql<{ id: string }>`select app.create_aml_control_version(
        ${kind}, 'Current control', ${content}, ${createHash('sha256').update(content).digest()},
        'Test source', ${today}::date, '2099-12-31'::date, ${preparer.id}
      ) as id`.execute(db)).rows[0]!.id;
      await sql`select app.approve_aml_control_version(${id}, ${approver.id})`.execute(db);
    }
  });
  afterAll(async () => {
    await owner.destroy();
    await db.destroy();
  });
  beforeEach(async () => {
    partner = await staffWith('partner');
    feeEarner = await staffWith('fee_earner');
    compliance = await staffWith('compliance');
    await approvedList([LISTED]);
  });

  it('accepts only sorted, distinct country codes and separate partner approval', async () => {
    const create = (countries: string[], actorId = compliance.id) => sql`select app.create_aml_country_list(
      ${countries}::text[], 'Test source', ${today}::date, ${actorId})`.execute(db);

    await expect(create(['KP', 'IR'])).rejects.toMatchObject({ code: '23514' });
    await expect(create(['IR', 'IR'])).rejects.toMatchObject({ code: '23514' });
    await expect(create(['ir'])).rejects.toMatchObject({ code: '23514' });
    await expect(create(['IR'], feeEarner.id)).rejects.toMatchObject({ code: '42501' });

    const both = await staffWith('compliance', 'partner');
    const id = (await sql<{ id: string }>`select app.create_aml_country_list(
      ${['IR', 'KP']}::text[], 'Test source', ${today}::date, ${both.id}) as id`.execute(db)).rows[0]!.id;
    await expect(sql`select app.approve_aml_country_list(${id}, ${both.id})`.execute(db)).rejects.toMatchObject({ code: '23514' });
    await expect(sql`select app.approve_aml_country_list(${id}, ${feeEarner.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });
  });

  it('denies direct writes for the application and the owner, even after a protected call', async () => {
    const { matterId } = await matter();
    await expect(sql`insert into app.aml_country_list_versions(version, countries, source, effective_from, prepared_by)
      values (999999, ${['IR']}::text[], 'Direct', ${today}::date, ${compliance.id})`.execute(db)).rejects.toMatchObject({ code: '42501' });

    // The protected function's write permission must not outlive the call.
    let directInsert: unknown = 'not attempted';
    await owner.transaction().execute(async (trx) => {
      await submit(matterId, {}, trx);
      directInsert = await sql`insert into app.aml_country_list_versions(version, countries, source, effective_from, prepared_by)
        values (999998, ${['IR']}::text[], 'Direct', ${today}::date, ${compliance.id})`.execute(trx)
        .then(() => 'inserted', (error: unknown) => error);
    }).catch(() => undefined);
    expect(directInsert).toMatchObject({ code: '42501' });
  });

  it('fixes the version, governing controls, country list and preparer', async () => {
    const { matterId, clientId } = await matter();
    const first = await assessment(await submit(matterId));
    const second = await assessment(await submit(matterId, { rating: 'high' }));

    expect(first).toMatchObject({ version: 1, client_id: clientId, in_scope: false, cdd_case_id: null, prepared_by: feeEarner.id });
    expect(second.version).toBe(2);
    const controls = await db.selectFrom('aml_risk_assessment_controls').select('kind').where('assessment_id', '=', first.id).execute();
    expect(controls.map((row) => row.kind).sort()).toEqual([...CONTROL_KINDS].sort());
  });

  it('forces a high rating for a PEP, unusual transactions or a listed country', async () => {
    const { matterId } = await matter();
    await expect(submit(matterId, { pep: true })).rejects.toMatchObject({ code: '23514' });
    await expect(submit(matterId, { unusual: true })).rejects.toMatchObject({ code: '23514' });
    await expect(submit(matterId, { jurisdictions: ['GB', LISTED] })).rejects.toMatchObject({ code: '23514' });

    const listed = await assessment(await submit(matterId, { jurisdictions: ['GB', LISTED], rating: 'high' }));
    expect(listed.high_risk_country).toBe(true);
  });

  it('requires a submitted CDD case for in-scope work and relies on the latest one', async () => {
    const { matterId, clientId } = await matter();
    await expect(submit(matterId, { inScope: true })).rejects.toMatchObject({ code: '23514' });

    const caseId = await submittedCdd(clientId);
    const relied = await assessment(await submit(matterId, { inScope: true }));
    expect(relied.cdd_case_id).toBe(caseId);
  });

  it('requires explicit grounds to lower a rating', async () => {
    const { matterId } = await matter();
    await submit(matterId, { rating: 'high' });
    await expect(submit(matterId, { rating: 'standard' })).rejects.toMatchObject({ code: '23514' });

    const lowered = await assessment(await submit(matterId, { rating: 'standard', loweringGrounds: true }));
    expect(lowered.lowers_previous).toBe(true);
    const raised = await assessment(await submit(matterId, { rating: 'high' }));
    expect(raised.lowers_previous).toBe(false);
  });

  it('rechecks matter access, refuses closed matters and bounds the review date', async () => {
    const { matterId } = await matter();
    const outsider = await staffWith('fee_earner');
    await expect(submit(matterId, { actorId: outsider.id })).rejects.toMatchObject({ code: '42501' });
    await expect(submit(randomUUID())).rejects.toMatchObject({ code: 'P0002' });
    await expect(submit(matterId, { reviewDueOn: today })).rejects.toMatchObject({ code: '23514' });
    await expect(submit(matterId, { actorId: compliance.id })).resolves.toEqual(expect.any(String));

    await sql`update app.matters set status = 'closed' where id = ${matterId}`.execute(owner);
    await expect(submit(matterId)).rejects.toMatchObject({ code: '23514' });
  });

  it('binds the ciphertext to the assessment id', async () => {
    const { matterId } = await matter();
    await expect(submit(matterId, { context: `aml-risk:${randomUUID()}` })).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes competing submissions into distinct versions', async () => {
    const { matterId } = await matter();
    await Promise.all([submit(matterId), submit(matterId), submit(matterId)]);
    const versions = await db.selectFrom('aml_risk_assessments').select('version').where('matter_id', '=', matterId).execute();
    expect(versions.map((row) => row.version).sort()).toEqual([1, 2, 3]);
  });

  it('keeps assessments and country lists immutable even for the owner', async () => {
    const { matterId } = await matter();
    const id = await submit(matterId);

    await expect(owner.updateTable('aml_risk_assessments').set({ rating: 'low' } as never).where('id', '=', id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner.deleteFrom('aml_risk_assessment_controls').where('assessment_id', '=', id).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner.updateTable('aml_country_list_versions').set({ source: 'Rewritten' } as never).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_country_list_approvals cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
  });
});
