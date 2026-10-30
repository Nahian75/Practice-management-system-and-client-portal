import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { AmlLicenceAction, Database } from '../database/schema.js';
import type { SealedComplianceData } from './compliance-data-cipher.js';
import type { ParsedSanctionsList } from './sanctions-list.js';
import type { Candidate, ListName } from './sanctions-matching.js';

export type SanctionsFailure = 'download' | 'too_large' | 'format' | 'older_report' | 'database';

export interface SanctionsListVersion {
  id: string; version: number; reportDate: string; source: 'download' | 'upload';
  designationCount: number; nameCount: number; importedAt: Date;
}
export type SanctionsState = 'clear' | 'unscreened' | 'stale' | 'possible_match' | 'confirmed';

/** A subject to screen: the client record (plain text) or a CDD subject (sealed until the service opens it). */
export type SubjectToScreen =
  | { ref: 'client'; name: string; birth: string | null }
  | { ref: string; sealed: SealedComplianceData };

export interface OpenCandidate {
  candidateId: string; clientId: string; clientReference: string; subjectRef: string; uniqueId: string;
  matchedName: string; birthAgreement: Candidate['birthAgreement']; screenedAt: Date;
}

export interface Licence {
  id: string; clientId: string; authority: 'ofsi' | 'otsi' | 'other'; kind: 'specific' | 'general'; reference: string;
  permittedActions: AmlLicenceAction[]; moneyLimitPence: string | null; effectiveFrom: string; expiresOn: string;
  conditions: SealedComplianceData; recordedBy: string; recordedAt: Date; revokedAt: Date | null;
}
export interface FrozenFunds {
  id: string; clientId: string; matterId: string; amountPence: string; reason: 'balance_at_confirmation' | 'receipt';
  financeTransactionId: string | null; frozenAt: Date;
}
export interface MoneyStatus {
  status: 'allowed' | 'frozen' | 'contact_compliance';
  licence: { id: string; limitPence: string; usedPence: string; expiresOn: string } | null;
}

export interface SanctionsStatus {
  listId: string | null; version: number | null; reportDate: string | null;
  lastSuccessAt: Date | null; lastFailureAt: Date | null; fresh: boolean;
}

@Injectable()
export class SanctionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  /** Returns a null list id when PostgreSQL refused an older report (it records that refusal itself). */
  async importList(parsed: ParsedSanctionsList, actorId: string | null, trx: Kysely<Database>) {
    const designations = parsed.designations.map((d) => ({
      unique_id: d.uniqueId, kind: d.kind, regime: d.regime, date_designated: d.dateDesignated,
      births: d.births, nationalities: d.nationalities,
    }));
    const names = parsed.designations.flatMap((d) => d.names.map((n) => ({
      unique_id: d.uniqueId, name: n.name, normalized: n.normalized, tokens: n.tokens, is_primary: n.isPrimary,
    })));
    const row = (await sql<{ list_id: string | null; changed: boolean }>`
      select list_id, changed from app.import_aml_sanctions_list(
        ${parsed.reportDate}::date, ${parsed.sha256}, ${parsed.byteSize}::integer,
        ${JSON.stringify(designations)}::jsonb, ${JSON.stringify(names)}::jsonb, ${actorId}::uuid
      )`.execute(trx)).rows[0]!;
    return { listId: row.list_id, changed: row.changed };
  }

  async recordFailure(failure: SanctionsFailure, actorId: string | null): Promise<void> {
    await sql`select app.record_aml_sanctions_failure(${failure}, ${actorId}::uuid)`.execute(this.db);
  }

  async status(executor: Kysely<Database> = this.db): Promise<SanctionsStatus> {
    const row = (await sql<{ list_id: string | null; version: number | null; report_date: string | null;
      last_success_at: Date | null; last_failure_at: Date | null; fresh: boolean }>`
      select list_id, version, report_date::text, last_success_at, last_failure_at, fresh from app.aml_sanctions_status()
    `.execute(executor)).rows[0]!;
    return { listId: row.list_id, version: row.version, reportDate: row.report_date,
      lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at, fresh: row.fresh };
  }

  async findList(id: string, executor: Kysely<Database> = this.db): Promise<SanctionsListVersion | undefined> {
    const row = await executor.selectFrom('aml_sanctions_lists').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toVersion(row) : undefined;
  }

  /** The client record and every subject of its latest submitted CDD case, or undefined for an unknown client. */
  async subjectsToScreen(clientId: string): Promise<SubjectToScreen[] | undefined> {
    const client = await this.db.selectFrom('clients as c')
      .leftJoin('client_individuals as i', 'i.client_id', 'c.id')
      .leftJoin('client_organisations as o', 'o.client_id', 'c.id')
      .select(['c.id', 'i.given_names', 'i.family_name', 'i.date_of_birth', 'o.legal_name'])
      .where('c.id', '=', clientId).executeTakeFirst();
    if (!client) return undefined;
    const name = client.legal_name ?? [client.given_names, client.family_name].filter(Boolean).join(' ');
    const subjects: SubjectToScreen[] = [{ ref: 'client', name, birth: client.date_of_birth ?? null }];
    const latest = await this.db.selectFrom('aml_cdd_cases').select('id').where('client_id', '=', clientId)
      .where('status', '=', 'submitted').orderBy('version', 'desc').limit(1).executeTakeFirst();
    if (latest) {
      const rows = await this.db.selectFrom('aml_cdd_subjects').selectAll().where('cdd_case_id', '=', latest.id).orderBy('id').execute();
      for (const row of rows) {
        subjects.push({ ref: row.id, sealed: { context: row.encryption_context, keyVersion: row.key_version,
          nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag } });
      }
    }
    return subjects;
  }

  /** List names sharing at least one word with the subject, with their designation's birth dates. */
  async namesSharingTokens(listId: string, tokens: string[]): Promise<ListName[]> {
    if (tokens.length === 0) return [];
    const rows = await this.db.selectFrom('aml_sanctions_names as n')
      .innerJoin('aml_sanctions_designations as d', (join) => join.onRef('d.list_id', '=', 'n.list_id').onRef('d.unique_id', '=', 'n.unique_id'))
      .select(['n.unique_id', 'n.name', 'n.normalized', 'n.tokens', 'd.births'])
      .where('n.list_id', '=', listId).where(sql<boolean>`n.tokens && ${tokens}::text[]`)
      .limit(5000).execute();
    return rows.map((row) => ({ uniqueId: row.unique_id, name: row.name, normalized: row.normalized, tokens: row.tokens, births: row.births }));
  }

  async recordScreening(input: { clientId: string; listId: string; subjectRef: string; candidates: Candidate[]; actorId: string | null },
    trx: Kysely<Database>): Promise<string> {
    const candidates = input.candidates.map((c) => ({ unique_id: c.uniqueId, matched_name: c.matchedName, birth_agreement: c.birthAgreement }));
    return (await sql<{ id: string }>`select app.record_aml_screening(
      ${input.clientId}::uuid, ${input.listId}::uuid, ${input.subjectRef}, ${JSON.stringify(candidates)}::jsonb, ${input.actorId}::uuid
    ) as id`.execute(trx)).rows[0]!.id;
  }

  async sanctionsState(clientId: string, executor: Kysely<Database> = this.db): Promise<SanctionsState> {
    return (await sql<{ state: SanctionsState }>`select app.aml_sanctions_state(${clientId}::uuid) as state`.execute(executor)).rows[0]!.state;
  }

  async resolveCandidate(input: { id: string; candidateId: string; outcome: 'false_positive' | 'confirmed';
    sealed: SealedComplianceData; actorId: string }, trx: Kysely<Database>): Promise<void> {
    const { sealed } = input;
    await sql`select app.resolve_aml_candidate(
      ${input.id}::uuid, ${input.candidateId}::uuid, ${input.outcome},
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  /** Unresolved, not carried-forward candidates on each subject's latest screening. */
  async openCandidates(before?: string): Promise<OpenCandidate[]> {
    const rows = (await sql<{ candidate_id: string; client_id: string; reference: string; subject_ref: string; unique_id: string;
      matched_name: string; birth_agreement: Candidate['birthAgreement']; screened_at: Date }>`
      select c.id as candidate_id, s.client_id, cl.reference, s.subject_ref, c.unique_id, c.matched_name, c.birth_agreement, s.screened_at
      from app.aml_screening_candidates c
      join app.aml_screenings s on s.id = c.screening_id
      join app.clients cl on cl.id = s.client_id
      where c.carried_from is null
        and not exists (select 1 from app.aml_candidate_resolutions r where r.candidate_id = c.id)
        and s.id = (select id from app.aml_screenings latest where latest.client_id = s.client_id
          and latest.subject_ref = s.subject_ref order by latest.screened_at desc, latest.id desc limit 1)
        and (${before ?? null}::uuid is null or c.id < ${before ?? null}::uuid)
      order by c.id desc limit 100`.execute(this.db)).rows;
    return rows.map((row) => ({ candidateId: row.candidate_id, clientId: row.client_id, clientReference: row.reference,
      subjectRef: row.subject_ref, uniqueId: row.unique_id, matchedName: row.matched_name, birthAgreement: row.birth_agreement,
      screenedAt: row.screened_at }));
  }

  async newId(trx: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(trx)).rows[0]!.id;
  }

  async candidateClient(candidateId: string, trx: Kysely<Database>): Promise<string> {
    return (await trx.selectFrom('aml_screening_candidates as c').innerJoin('aml_screenings as s', 's.id', 'c.screening_id')
      .select('s.client_id').where('c.id', '=', candidateId).executeTakeFirstOrThrow()).client_id;
  }

  async recordLicence(input: Omit<Licence, 'recordedBy' | 'recordedAt' | 'revokedAt'> & { actorId: string },
    trx: Kysely<Database>): Promise<void> {
    const sealed = input.conditions;
    await sql`select app.record_aml_licence(
      ${input.id}::uuid, ${input.clientId}::uuid, ${input.authority}, ${input.kind}, ${input.reference},
      ${input.permittedActions}::text[], ${input.moneyLimitPence}::bigint, ${input.effectiveFrom}::date, ${input.expiresOn}::date,
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async revokeLicence(input: { id: string; licenceId: string; sealed: SealedComplianceData; actorId: string }, trx: Kysely<Database>) {
    const { sealed } = input;
    await sql`select app.revoke_aml_licence(
      ${input.id}::uuid, ${input.licenceId}::uuid,
      ${sealed.context}, ${sealed.keyVersion}::smallint, ${sealed.nonce}, ${sealed.ciphertext}, ${sealed.authTag},
      ${input.actorId}::uuid
    )`.execute(trx);
  }

  async licences(clientId: string, executor: Kysely<Database> = this.db): Promise<Licence[]> {
    const rows = await executor.selectFrom('aml_sanctions_licences as l')
      .leftJoin('aml_licence_revocations as v', 'v.licence_id', 'l.id')
      .selectAll('l').select('v.revoked_at')
      .where('l.client_id', '=', clientId).orderBy('l.recorded_at', 'desc').execute();
    return rows.map((row) => ({ id: row.id, clientId: row.client_id, authority: row.authority, kind: row.licence_kind,
      reference: row.reference, permittedActions: row.permitted_actions, moneyLimitPence: row.money_limit_pence,
      effectiveFrom: row.effective_from, expiresOn: row.expires_on,
      conditions: { context: row.encryption_context, keyVersion: row.key_version, nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      recordedBy: row.recorded_by, recordedAt: row.recorded_at, revokedAt: row.revoked_at }));
  }

  async frozenFunds(clientId: string): Promise<FrozenFunds[]> {
    const rows = await this.db.selectFrom('aml_frozen_funds').selectAll().where('client_id', '=', clientId)
      .orderBy('frozen_at', 'desc').limit(500).execute();
    return rows.map((row) => ({ id: row.id, clientId: row.client_id, matterId: row.matter_id, amountPence: row.amount_pence,
      reason: row.reason, financeTransactionId: row.finance_transaction_id, frozenAt: row.frozen_at }));
  }

  async moneyStatus(matterId: string): Promise<MoneyStatus> {
    const row = (await sql<{ status: MoneyStatus['status']; licence_id: string | null; limit_pence: string | null;
      used_pence: string | null; licence_expires_on: string | null }>`
      select status, licence_id, limit_pence::text, used_pence::text, licence_expires_on::text from app.aml_money_status(${matterId}::uuid)
    `.execute(this.db)).rows[0]!;
    return { status: row.status, licence: row.licence_id && row.limit_pence && row.used_pence && row.licence_expires_on
      ? { id: row.licence_id, limitPence: row.limit_pence, usedPence: row.used_pence, expiresOn: row.licence_expires_on } : null };
  }

  async clientsToRescreen(after: string | null,pendingOnly=false): Promise<string[]> {
    if(pendingOnly)return (await sql<{id:string}>`SELECT id FROM app.aml_pending_rescreen_clients(${after}::uuid,200) AS id`.execute(this.db)).rows.map(row=>row.id);
    return (await sql<{ id: string }>`select id from app.aml_clients_to_rescreen(${after}::uuid, 200) as id`.execute(this.db))
      .rows.map((row) => row.id);
  }

  async listVersions(before?: string): Promise<SanctionsListVersion[]> {
    let query = this.db.selectFrom('aml_sanctions_lists').selectAll();
    if (before) query = query.where('id', '<', before);
    return (await query.orderBy('id', 'desc').limit(100).execute()).map(toVersion);
  }
}

function toVersion(row: { id: string; version: number; report_date: string; source: string; designation_count: number;
  name_count: number; imported_at: Date }): SanctionsListVersion {
  return { id: row.id, version: row.version, reportDate: row.report_date, source: row.source as 'download' | 'upload',
    designationCount: row.designation_count, nameCount: row.name_count, importedAt: row.imported_at };
}
