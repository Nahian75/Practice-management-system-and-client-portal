import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { ComplianceDataCipher } from '../src/compliance/compliance-data-cipher.js';
import type { Database } from '../src/database/schema.js';
import { createTestAccount, grantTestRole, type TestAccount } from './accounts.js';
import { testEnv } from './database.js';

// Builds AML records through the same protected database functions the API uses.
// Nothing here bypasses a rule; it only saves each test from repeating the steps.

const CONTROL_KINDS = ['ml_tf_risk_assessment', 'proliferation_financing_risk_assessment',
  'sanctions_risk_assessment', 'aml_policy', 'sanctions_policy'];
/** A user-assigned ISO code, so no real country is treated as high risk by a test. */
export const TEST_LISTED_COUNTRY = 'QZ';

const cipher = new ComplianceDataCipher(testEnv());

async function staffWith(db: Kysely<Database>, ...roles: Parameters<typeof grantTestRole>[2][]): Promise<TestAccount> {
  const account = await createTestAccount(db, 'staff');
  for (const role of roles) await grantTestRole(db, account.id, role);
  return account;
}

export async function londonDates(db: Kysely<Database>): Promise<{ today: string; inAYear: string }> {
  return (await sql<{ today: string; inAYear: string }>`select app.london_today()::text as today,
    (app.london_today() + 365)::text as "inAYear"`.execute(db)).rows[0]!;
}

/**
 * Publishes and approves current versions of the five firm controls. With
 * `countries`, also makes that list the latest approved high-risk-country list.
 */
export async function approveAmlFramework(db: Kysely<Database>, countries: string[] | null = [TEST_LISTED_COUNTRY]): Promise<void> {
  const { today } = await londonDates(db);
  const preparer = await staffWith(db, 'compliance');
  const approver = await staffWith(db, 'partner');
  for (const kind of CONTROL_KINDS) {
    const content = `Test ${kind} ${randomUUID()}`;
    const id = (await sql<{ id: string }>`select app.create_aml_control_version(
      ${kind}, 'Current control', ${content}, ${createHash('sha256').update(content).digest()},
      'Test source', ${today}::date, '2099-12-31'::date, ${preparer.id}
    ) as id`.execute(db)).rows[0]!.id;
    await sql`select app.approve_aml_control_version(${id}, ${approver.id})`.execute(db);
  }
  if (countries) {
    const id = (await sql<{ id: string }>`select app.create_aml_country_list(
      ${countries}::text[], 'Test list', ${today}::date, ${preparer.id}) as id`.execute(db)).rows[0]!.id;
    await sql`select app.approve_aml_country_list(${id}, ${approver.id})`.execute(db);
  }
}

/** An open individual-client matter whose team is the fee earner and supervising partner. */
export async function createTeamMatter(db: Kysely<Database>, feeEarner: TestAccount, partner: TestAccount) {
  return db.transaction().execute(async (trx) => {
    const client = await trx.insertInto('clients').values({ kind: 'individual', created_by: feeEarner.id })
      .returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('client_individuals').values({
      client_id: client.id, given_names: randomUUID(), family_name: randomUUID(), date_of_birth: '1980-01-02',
      address_line1: '1 Test Street', town: 'London', postcode: 'SW1A 1AA', country: 'GB',
    }).execute();
    const check = await trx.insertInto('conflict_checks').values({ client_id: client.id, requested_by: feeEarner.id, names: [randomUUID()] })
      .returning('id').executeTakeFirstOrThrow();
    const matter = await trx.insertInto('matters').values({ client_id: client.id, title: 'AML test matter', matter_type: 'other',
      opened_by: feeEarner.id, conflict_check_id: check.id }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('matter_team').values([
      { matter_id: matter.id, account_id: feeEarner.id, role: 'fee_earner', added_by: feeEarner.id },
      { matter_id: matter.id, account_id: partner.id, role: 'supervising_partner', added_by: feeEarner.id },
    ]).execute();
    return { matterId: matter.id, clientId: client.id };
  });
}

const sealed = (value: unknown, context: string) => cipher.seal(value, context);

/** Submits a complete one-subject CDD case for an individual client. */
export async function submitTestCdd(db: Kysely<Database>, clientId: string, complianceId: string) {
  const { today } = await londonDates(db);
  const caseId = (await sql<{ id: string }>`select app.create_aml_cdd_case(
    ${clientId}, 'Ongoing legal services for the client', 'CDD before accepting the instructions', ${complianceId}
  ) as id`.execute(db)).rows[0]!.id;
  const evidenceId = randomUUID();
  const metadata = sealed({ fileName: 'passport.pdf', documentIdentifier: null, providerPayloadHash: null }, `aml-evidence-metadata:${evidenceId}`);
  await sql`select app.add_aml_cdd_evidence(
    ${evidenceId}, ${caseId}, 'passport', 'GB'::char(2), '2020-01-01'::date, '2099-01-01'::date,
    ${metadata.context}, ${metadata.keyVersion}::smallint, ${metadata.nonce}, ${metadata.ciphertext}, ${metadata.authTag},
    'application/pdf', 10, ${Buffer.alloc(32, 3)}, ${`compliance/${randomUUID()}`},
    1::smallint, ${Buffer.alloc(12, 4)}, ${Buffer.alloc(32, 5)}, ${Buffer.alloc(16, 6)}, ${complianceId}
  )`.execute(db);
  const subjectId = randomUUID();
  const subject = sealed({ name: 'Test Client', dateOfBirth: '1980-01-02' }, `aml-subject:${subjectId}`);
  await sql`select app.add_aml_cdd_subject(
    ${subjectId}, ${caseId}, 'individual', 'client',
    ${subject.context}, ${subject.keyVersion}::smallint, ${subject.nonce}, ${subject.ciphertext}, ${subject.authTag}, ${complianceId}
  )`.execute(db);
  const verificationId = randomUUID();
  const verification = sealed({ documentIdentifier: null, providerResult: null, reliance: null }, `aml-verification:${verificationId}`);
  await sql`select app.add_aml_cdd_verification(
    ${verificationId}, ${caseId}, ${subjectId}, ${evidenceId}, 'Passport', 'GB'::char(2),
    ${today}::date, '2099-01-01'::date, 'in_person', 'verified', null, null,
    ${verification.context}, ${verification.keyVersion}::smallint, ${verification.nonce}, ${verification.ciphertext},
    ${verification.authTag}, ${complianceId}
  )`.execute(db);
  await sql`select app.submit_aml_cdd_case(${caseId}, ${complianceId})`.execute(db);
  return { caseId, subjectId, evidenceId };
}

export interface TestAssessment {
  inScope?: boolean; rating?: 'low' | 'standard' | 'high'; pep?: boolean; unusual?: boolean;
  jurisdictions?: string[]; expectedValue?: string; reviewDueOn?: string; graceDays?: number; loweringGrounds?: boolean;
}

const NARRATIVE = {
  scopeReason: 'Test scope reason for the matter.', clientRisk: 'Test client risk narrative.',
  serviceRisk: 'Test service risk narrative.', purposeAndNature: 'Test purpose and nature narrative.',
  fundingRisk: 'Test funding risk narrative.', sanctionsExposure: 'Test sanctions exposure narrative.',
  rationale: 'Test rationale for the rating.', mitigations: 'Test mitigations narrative.',
  requiredChecks: 'Test required checks narrative.', monitoringPlan: 'Test monitoring plan narrative.',
};

/** Submits an assessment version as `actorId`, who must be on the matter team or hold Compliance. */
export async function submitTestAssessment(db: Kysely<Database>, matterId: string, actorId: string, options: TestAssessment = {}) {
  const { inAYear } = await londonDates(db);
  const id = randomUUID();
  const seal = sealed({ ...NARRATIVE, loweringGrounds: options.loweringGrounds ? 'Test lowering grounds.' : null }, `aml-risk:${id}`);
  await sql`select app.submit_aml_risk_assessment(
    ${id}, ${matterId}, ${options.inScope ?? false}, ${options.rating ?? 'standard'},
    ${options.pep ?? false}, ${options.unusual ?? false}, false, false, false, false, false, false,
    ${options.jurisdictions ?? ['GB']}::text[], ${options.expectedValue ?? 'under_10k'},
    ${options.reviewDueOn ?? inAYear}::date, ${options.graceDays ?? 30}::smallint, ${options.loweringGrounds ?? false},
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId}
  )`.execute(db);
  return id;
}

export async function addTestMeasure(db: Kysely<Database>, assessmentId: string, kind: string, actorId: string) {
  const id = randomUUID();
  const seal = sealed({ text: `Test ${kind} measure.` }, `aml-measure:${id}`);
  await sql`select app.add_aml_measure(${id}, ${assessmentId}, ${kind},
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}

export async function recordTestMeasureResult(db: Kysely<Database>, measureId: string, actorId: string,
  outcome: 'satisfied' | 'not_satisfied' = 'satisfied', evidenceIds: string[] = []) {
  const id = randomUUID();
  const seal = sealed({ text: 'Test measure result.' }, `aml-measure-result:${id}`);
  await sql`select app.record_aml_measure_result(${id}, ${measureId}, ${outcome}, ${evidenceIds}::uuid[],
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}

export async function recordTestSourceConclusion(db: Kysely<Database>, assessmentId: string, actorId: string, options: {
  kind?: 'funds' | 'wealth'; subjectId?: string | null; outcome?: 'satisfied' | 'not_satisfied'; evidenceIds?: string[];
} = {}) {
  const id = randomUUID();
  const seal = sealed({ text: 'Test source conclusion.' }, `aml-source:${id}`);
  await sql`select app.record_aml_source_conclusion(${id}, ${assessmentId}, ${options.kind ?? 'funds'},
    ${options.subjectId ?? null}::uuid, 0::bigint, 1000000::bigint, ${options.outcome ?? 'satisfied'},
    ${options.evidenceIds ?? []}::uuid[],
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}

export { staffWith as createAmlStaff };

/**
 * Makes sure current approved firm controls exist, and a current country list containing
 * `countries`, publishing only what is missing. Parallel test files share one framework this
 * way: publishing a newer control would make every cleared matter due for review.
 */
export async function ensureAmlFramework(db: Kysely<Database>, countries: string[] = [TEST_LISTED_COUNTRY]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended('test.aml_framework', 0))`.execute(trx);
    const { today } = await londonDates(trx);
    const current = await trx.selectFrom('aml_control_versions as v')
      .innerJoin('aml_control_approvals as p', 'p.control_version_id', 'v.id')
      .select('v.kind').distinct()
      .where('v.effective_from', '<=', today).where('v.review_due_on', '>=', today).execute();
    const list = await trx.selectFrom('aml_country_list_versions as v')
      .innerJoin('aml_country_list_approvals as p', 'p.country_list_version_id', 'v.id')
      .select('v.countries').where('v.effective_from', '<=', today).orderBy('v.version', 'desc').limit(1).executeTakeFirst();
    const missingControls = CONTROL_KINDS.some((kind) => !current.some((row) => row.kind === kind));
    const listCovers = list !== undefined && countries.every((code) => list.countries.includes(code));
    const publish = countries.length > 0 ? countries : [TEST_LISTED_COUNTRY];
    if (missingControls) await approveAmlFramework(trx, listCovers ? null : publish);
    else if (!listCovers) await approveCountryList(trx, publish);
  });
}

async function approveCountryList(db: Kysely<Database>, countries: string[]): Promise<void> {
  const { today } = await londonDates(db);
  const preparer = await staffWith(db, 'compliance');
  const approver = await staffWith(db, 'partner');
  const id = (await sql<{ id: string }>`select app.create_aml_country_list(
    ${[...countries].sort()}::text[], 'Test list', ${today}::date, ${preparer.id}) as id`.execute(db)).rows[0]!.id;
  await sql`select app.approve_aml_country_list(${id}, ${approver.id})`.execute(db);
}

export async function decideTestClearance(db: Kysely<Database>, assessmentId: string, actorId: string,
  decision: 'approved' | 'refused' = 'approved') {
  const id = randomUUID();
  const seal = sealed({ text: 'Test clearance reasoning.' }, `aml-clearance:${id}`);
  await sql`select app.decide_aml_clearance(${id}, ${assessmentId}, ${decision},
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}

export async function approveTestSenior(db: Kysely<Database>, clearanceId: string, actorId: string): Promise<void> {
  await sql`select app.approve_aml_senior(${clearanceId}, ${actorId})`.execute(db);
}

/**
 * Clears a matter's compliance gate the way a firm would for low-risk, out-of-scope
 * work: one Compliance holder assesses it and another clears it. Tests of other
 * modules use this so gated work (time, billing, documents, money) can proceed.
 */
export async function clearMatterForTests(db: Kysely<Database>, matterId: string): Promise<void> {
  await ensureAmlFramework(db, []);
  const preparer = await staffWith(db, 'compliance');
  const assessmentId = await submitTestAssessment(db, matterId, preparer.id);
  const approver = await staffWith(db, 'compliance');
  await decideTestClearance(db, assessmentId, approver.id);
}

export async function imposeTestHold(db: Kysely<Database>, target: { clientId?: string; matterId?: string }, actorId: string) {
  const id = randomUUID();
  const seal = sealed({ text: 'Test hold reason.' }, `aml-hold:${id}`);
  await sql`select app.impose_aml_hold(${id}, ${target.clientId ?? null}::uuid, ${target.matterId ?? null}::uuid,
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}

export async function liftTestHold(db: Kysely<Database>, holdId: string, actorId: string): Promise<void> {
  const id = randomUUID();
  const seal = sealed({ text: 'Test lift reason.' }, `aml-hold-lift:${id}`);
  await sql`select app.lift_aml_hold(${id}, ${holdId},
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
}

export async function grantTestStartException(db: Kysely<Database>, assessmentId: string, actorId: string,
  actions: ('documents' | 'time')[], expiresOn: string) {
  const id = randomUUID();
  const seal = sealed({ text: 'Test early-start grounds.' }, `aml-exception:${id}`);
  await sql`select app.grant_aml_start_exception(${id}, ${assessmentId}, ${actions}::text[], ${expiresOn}::date,
    ${seal.context}, ${seal.keyVersion}::smallint, ${seal.nonce}, ${seal.ciphertext}, ${seal.authTag}, ${actorId})`.execute(db);
  return id;
}
