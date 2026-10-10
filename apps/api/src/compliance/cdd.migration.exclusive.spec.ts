import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestAccount, grantTestRole, type TestAccount } from '../../test/accounts.js';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../../test/database.js';
import { createDatabase } from '../database/database.js';
import type { Database, StaffRole } from '../database/schema.js';

const CONTROL_KINDS = ['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy'];

describe('CDD database rules', () => {
  let db: Kysely<Database>;
  let owner: Kysely<Database>;
  let partner: TestAccount;
  let compliance: TestAccount;
  let today: string;

  async function staffWith(...roles: StaffRole[]) {
    const account = await createTestAccount(db, 'staff');
    for (const role of roles) await grantTestRole(db, account.id, role);
    return account;
  }

  async function client(createdBy = partner.id) {
    return db.transaction().execute(async (trx) => {
      const created = await trx.insertInto('clients').values({ kind: 'organisation', created_by: createdBy })
        .returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('client_organisations').values({
        client_id: created.id, legal_name: `Test Company ${randomUUID()}`, organisation_type: 'company',
        registration_number: '12345678', email: null, phone: null, address_line1: '1 Test Street',
        address_line2: null, town: 'London', postcode: 'SW1A 1AA', country: 'GB',
      }).execute();
      return created.id;
    });
  }

  async function createCase(clientId: string, actorId = partner.id) {
    return (await sql<{ id: string }>`select app.create_aml_cdd_case(
      ${clientId}, 'Ongoing corporate legal services', 'CDD before accepting the proposed instructions', ${actorId}
    ) as id`.execute(db)).rows[0]!.id;
  }

  /** Well-formed but meaningless ciphertext: these tests exercise the database rules, not encryption. */
  const sealed = (context: string) => ({
    context, key: 1, nonce: Buffer.alloc(12, 1), ciphertext: Buffer.from('{}'), tag: Buffer.alloc(16, 2),
  });

  function addEvidence(id: string, caseId: string, issuedOn: string, expiresOn: string | null, actorId: string) {
    const x = sealed(`aml-evidence-metadata:${id}`);
    return sql`select app.add_aml_cdd_evidence(
      ${id}, ${caseId}, 'passport', 'GB'::char(2), ${issuedOn}::date, ${expiresOn}::date,
      ${x.context}, ${x.key}::smallint, ${x.nonce}, ${x.ciphertext}, ${x.tag},
      'application/pdf', 10, ${Buffer.alloc(32, 3)}, ${`compliance/${randomUUID()}`},
      1::smallint, ${Buffer.alloc(12, 4)}, ${Buffer.alloc(32, 5)}, ${Buffer.alloc(16, 6)}, ${actorId}
    )`.execute(db);
  }

  async function evidence(caseId: string, actorId = partner.id) {
    const id = randomUUID();
    await addEvidence(id, caseId, '2020-01-01', '2099-01-01', actorId);
    return id;
  }

  function addSubject(id: string, caseId: string, context: string, relationship: string, actorId: string) {
    const x = sealed(context);
    return sql`select app.add_aml_cdd_subject(
      ${id}, ${caseId}, 'legal_entity', ${relationship},
      ${x.context}, ${x.key}::smallint, ${x.nonce}, ${x.ciphertext}, ${x.tag}, ${actorId}
    )`.execute(db);
  }

  async function subject(caseId: string, relationship = 'client', actorId = partner.id) {
    const id = randomUUID();
    await addSubject(id, caseId, `aml-subject:${id}`, relationship, actorId);
    return id;
  }

  async function verify(caseId: string, subjectId: string, evidenceId: string, actorId = partner.id) {
    const id = randomUUID();
    const x = sealed(`aml-verification:${id}`);
    await sql`select app.add_aml_cdd_verification(
      ${id}, ${caseId}, ${subjectId}, ${evidenceId}, 'Companies registry', 'GB'::char(2),
      ${today}::date, '2099-01-01'::date, 'manual', 'verified', null, null,
      ${x.context}, ${x.key}::smallint, ${x.nonce}, ${x.ciphertext}, ${x.tag}, ${actorId}
    )`.execute(db);
    return id;
  }

  const submit = (caseId: string) => sql`select app.submit_aml_cdd_case(${caseId}, ${partner.id})`.execute(db);

  beforeAll(async () => {
    db = createDatabase<Database>(testAppDatabaseUrl(), 4);
    owner = createDatabase<Database>(testOwnerDatabaseUrl(), 2);
    today = (await sql<{ today: string }>`select (clock_timestamp() at time zone 'Europe/London')::date::text today`
      .execute(db)).rows[0]!.today;
    const preparer = await staffWith('compliance');
    const approver = await staffWith('partner');
    for (const kind of CONTROL_KINDS) {
      const content = `Database test ${kind} ${randomUUID()}`;
      const id = (await sql<{ id: string }>`select app.create_aml_control_version(
        ${kind}, 'Current control', ${content}, ${createHash('sha256').update(content).digest()},
        'Test source', ${today}::date, '2099-12-31'::date, ${preparer.id}
      ) id`.execute(db)).rows[0]!.id;
      await sql`select app.approve_aml_control_version(${id}, ${approver.id})`.execute(db);
    }
  });
  afterAll(async () => {
    await owner.destroy();
    await db.destroy();
  });
  beforeEach(async () => {
    partner = await staffWith('partner');
    compliance = await staffWith('compliance');
  });

  it('denies direct application and owner inserts outside protected functions', async () => {
    const clientId = await client();
    const insert = (version: number) => sql`insert into app.aml_cdd_cases(client_id, version, intended_relationship, reason, prepared_by)
      values (${clientId}, ${version}, 'Direct relationship', 'Direct unprotected reason', ${partner.id})`;

    await expect(insert(98).execute(db)).rejects.toMatchObject({ code: '42501' });
    await expect(insert(99).execute(owner)).rejects.toMatchObject({ code: '42501' });
  });

  it('rechecks live roles and client visibility inside database functions', async () => {
    const clientId = await client();
    const outsider = await staffWith('fee_earner');
    await expect(createCase(clientId, outsider.id)).rejects.toMatchObject({ code: '42501' });

    const caseId = await createCase(clientId, compliance.id);
    expect(caseId).toEqual(expect.any(String));
    await db.updateTable('account_roles').set({ revoked_at: new Date(), revoked_by: partner.id })
      .where('account_id', '=', compliance.id).where('role', '=', 'compliance').execute();

    await expect(subject(caseId, 'client', compliance.id)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps submitted history immutable even for the owner', async () => {
    const caseId = await createCase(await client());
    const evidenceId = await evidence(caseId);
    const subjectId = await subject(caseId);
    await verify(caseId, subjectId, evidenceId);
    await submit(caseId);

    await expect(owner.updateTable('aml_cdd_cases').set({ reason: 'Rewritten reason' } as never)
      .where('id', '=', caseId).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(owner.updateTable('aml_cdd_subjects').set({ relationship: 'beneficial_owner' } as never)
      .where('id', '=', subjectId).execute()).rejects.toMatchObject({ code: '42501' });
    await expect(owner.deleteFrom('aml_cdd_evidence').where('id', '=', evidenceId).execute())
      .rejects.toMatchObject({ code: '42501' });
    await expect(sql`truncate app.aml_cdd_verifications cascade`.execute(owner)).rejects.toMatchObject({ code: '42501' });
    await expect(subject(caseId)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects cross-case references and incomplete submission', async () => {
    const first = await createCase(await client());
    const second = await createCase(await client());
    const evidenceId = await evidence(first);
    const subjectId = await subject(second);

    await expect(verify(second, subjectId, evidenceId)).rejects.toMatchObject({ code: '23514' });
    await expect(submit(second)).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes competing drafts so only one can exist', async () => {
    const clientId = await client();
    const attempts = await Promise.allSettled([createCase(clientId), createCase(clientId)]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: '23505' });
    const rows = await db.selectFrom('aml_cdd_cases').select(['id', 'version']).where('client_id', '=', clientId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
  });

  it('binds ciphertext contexts to record ids and requires case-local graph nodes', async () => {
    const caseId = await createCase(await client());

    await expect(addSubject(randomUUID(), caseId, `aml-subject:${randomUUID()}`, 'client', partner.id))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects future-dated evidence and identity checks in PostgreSQL', async () => {
    const caseId = await createCase(await client());

    await expect(addEvidence(randomUUID(), caseId, '2099-01-01', null, partner.id)).rejects.toMatchObject({ code: '23514' });
  });
});
