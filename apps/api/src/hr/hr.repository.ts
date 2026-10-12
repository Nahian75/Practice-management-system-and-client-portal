import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, HrCorrectionCategory, HrEngagementKind, HrFileCategory } from '../database/schema.js';
import type { SealedHrData } from './hr-data-cipher.js';
import type { HrDirectoryMember, HrWorkPatternInput } from './hr.js';

export interface SealedHrRow {
  context: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
}
export interface SummaryRow {
  person_id: string; account_id: string; display_name: string; work_email: string;
  account_status: 'invited' | 'active' | 'disabled'; access_kind: 'self' | 'hr' | 'manager';
  engagement_id: string | null; engagement_kind: HrEngagementKind | null;
  started_on: string | null; ended_on: string | null; job_title: string | null;
  team: string | null; work_location: string | null; manager_person_id: string | null;
  manager_account_id: string | null; manager_name: string | null;
}
export interface EngagementRow {
  id: string; person_id: string; engagement_kind: HrEngagementKind; started_on: string;
  ended_on: string | null; created_by: string; created_at: Date;
}
export interface TermsRow {
  id: string; engagement_id: string; effective_on: string; job_title: string;
  team: string | null; work_location: string | null; recorded_by: string; recorded_at: Date;
}
export interface ManagerRow {
  id: string; person_id: string; action: 'assigned' | 'cleared'; manager_person_id: string | null;
  effective_on: string; recorded_by: string; recorded_at: Date;
}
export interface WorkPatternRow {
  id: string; engagement_id: string; effective_on: string; time_zone: string;
  monday_minutes: number; tuesday_minutes: number; wednesday_minutes: number;
  thursday_minutes: number; friday_minutes: number; saturday_minutes: number; sunday_minutes: number;
  recorded_by: string; recorded_at: Date;
}
export interface CorrectionRow extends SealedHrRow {
  id: string; person_id: string; category: HrCorrectionCategory; submitted_by: string; submitted_at: Date;
  outcome: 'resolved' | 'rejected' | null; event_context: string | null; event_key_version: number | null;
  event_nonce: Buffer | null; event_ciphertext: Buffer | null; event_auth_tag: Buffer | null;
  decided_by: string | null; decided_at: Date | null; account_id?: string; display_name?: string;
}
export interface HrFileRow {
  id: string; person_id: string; category: HrFileCategory; worker_visible: boolean;
  metadata_context: string; metadata_key_version: number; metadata_nonce: Buffer;
  metadata_ciphertext: Buffer; metadata_auth_tag: Buffer; media_type: string; size_bytes: number;
  sha256: Buffer; storage_key: string; file_key_version: number; file_key_nonce: Buffer;
  wrapped_file_key: Buffer; file_key_tag: Buffer; uploaded_by: string; uploaded_at: Date;
}

@Injectable()
export class HrRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  async newId(executor: Kysely<Database> = this.db): Promise<string> {
    return (await sql<{ id: string }>`select uuidv7() as id`.execute(executor)).rows[0]!.id;
  }

  async directory(actorId: string): Promise<HrDirectoryMember[]> {
    const rows = (await sql<{ account_id: string; person_id: string | null; display_name: string;
      work_email: string; job_title: string | null; team: string | null; work_location: string | null }>`
      select * from app.list_hr_directory(${actorId}::uuid)`.execute(this.db)).rows;
    return rows.map((row) => ({ accountId: row.account_id, personId: row.person_id,
      displayName: row.display_name, workEmail: row.work_email, jobTitle: row.job_title,
      team: row.team, workLocation: row.work_location }));
  }

  async people(actorId: string) {
    return (await sql<{ person_id: string; account_id: string; display_name: string; work_email: string;
      account_status: 'invited' | 'active' | 'disabled'; engagement_id: string | null;
      engagement_kind: HrEngagementKind | null; started_on: string | null; ended_on: string | null;
      job_title: string | null; team: string | null; work_location: string | null }>`
      select * from app.list_hr_people(${actorId}::uuid)`.execute(this.db)).rows;
  }

  async ownPersonId(actorId: string): Promise<string | undefined> {
    return (await sql<{ id: string | null }>`select app.read_own_hr_person(${actorId}::uuid) as id`
      .execute(this.db)).rows[0]?.id ?? undefined;
  }

  async summary(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<SummaryRow | undefined> {
    return (await sql<SummaryRow>`select * from app.read_hr_person_summary(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows[0];
  }

  async contact(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<(SealedHrRow & { id: string }) | undefined> {
    return (await sql<SealedHrRow & { id: string }>`select * from app.read_hr_contact(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows[0];
  }

  async privateDetails(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<(SealedHrRow & { id: string }) | undefined> {
    return (await sql<SealedHrRow & { id: string }>`select * from app.read_hr_private(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows[0];
  }

  async engagements(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<EngagementRow[]> {
    return (await sql<EngagementRow>`select * from app.read_hr_engagements(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async terms(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<TermsRow[]> {
    return (await sql<TermsRow>`select * from app.read_hr_terms(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async managers(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<ManagerRow[]> {
    return (await sql<ManagerRow>`select * from app.read_hr_manager_events(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async workPatterns(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<WorkPatternRow[]> {
    return (await sql<WorkPatternRow>`select * from app.read_hr_work_patterns(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async corrections(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<CorrectionRow[]> {
    return (await sql<CorrectionRow>`select * from app.read_hr_corrections(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async allCorrections(actorId: string): Promise<CorrectionRow[]> {
    return (await sql<CorrectionRow>`select * from app.list_hr_corrections(${actorId}::uuid)`
      .execute(this.db)).rows;
  }

  async files(personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<HrFileRow[]> {
    return (await sql<HrFileRow>`select * from app.read_hr_files(${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows;
  }

  async file(fileId: string, personId: string, actorId: string, executor: Kysely<Database> = this.db): Promise<HrFileRow | undefined> {
    return (await sql<HrFileRow>`select * from app.read_hr_file(${fileId}::uuid,${personId}::uuid,${actorId}::uuid)`
      .execute(executor)).rows[0];
  }

  async createPerson(accountId: string, actorId: string, executor: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select app.create_hr_person(${accountId}::uuid,${actorId}::uuid) as id`
      .execute(executor)).rows[0]!.id;
  }

  async recordContact(id: string, personId: string, sealed: SealedHrData, actorId: string, executor: Kysely<Database>): Promise<void> {
    await sql`select app.record_hr_contact_version(${id}::uuid,${personId}::uuid,${sealed.context},
      ${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${actorId}::uuid)`
      .execute(executor);
  }

  async recordPrivate(id: string, personId: string, sealed: SealedHrData, actorId: string, executor: Kysely<Database>): Promise<void> {
    await sql`select app.record_hr_private_version(${id}::uuid,${personId}::uuid,${sealed.context},
      ${sealed.keyVersion}::smallint,${sealed.nonce},${sealed.ciphertext},${sealed.authTag},${actorId}::uuid)`
      .execute(executor);
  }

  async createEngagement(input: { personId: string; kind: HrEngagementKind; startedOn: string;
    jobTitle: string; team: string | null; workLocation: string | null; pattern: HrWorkPatternInput;
    actorId: string }, executor: Kysely<Database>): Promise<string> {
    const p = input.pattern;
    return (await sql<{ id: string }>`select app.create_hr_engagement(${input.personId}::uuid,${input.kind},
      ${input.startedOn}::date,${input.jobTitle},${input.team},${input.workLocation},${p.timeZone},
      ${p.mondayMinutes}::smallint,${p.tuesdayMinutes}::smallint,${p.wednesdayMinutes}::smallint,
      ${p.thursdayMinutes}::smallint,${p.fridayMinutes}::smallint,${p.saturdayMinutes}::smallint,
      ${p.sundayMinutes}::smallint,${input.actorId}::uuid) as id`.execute(executor)).rows[0]!.id;
  }

  async recordTerms(input: { personId: string; engagementId: string; effectiveOn: string; jobTitle: string;
    team: string | null; workLocation: string | null; actorId: string }, executor: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select app.record_hr_employment_terms(${input.personId}::uuid,${input.engagementId}::uuid,
      ${input.effectiveOn}::date,${input.jobTitle},${input.team},${input.workLocation},${input.actorId}::uuid) as id`
      .execute(executor)).rows[0]!.id;
  }

  async recordWorkPattern(input: { personId: string; engagementId: string; effectiveOn: string; pattern: HrWorkPatternInput;
    actorId: string }, executor: Kysely<Database>): Promise<string> {
    const p = input.pattern;
    return (await sql<{ id: string }>`select app.record_hr_work_pattern(${input.personId}::uuid,${input.engagementId}::uuid,
      ${input.effectiveOn}::date,${p.timeZone},${p.mondayMinutes}::smallint,${p.tuesdayMinutes}::smallint,
      ${p.wednesdayMinutes}::smallint,${p.thursdayMinutes}::smallint,${p.fridayMinutes}::smallint,
      ${p.saturdayMinutes}::smallint,${p.sundayMinutes}::smallint,${input.actorId}::uuid) as id`
      .execute(executor)).rows[0]!.id;
  }

  async recordManager(input: { personId: string; managerPersonId: string | null; effectiveOn: string;
    actorId: string }, executor: Kysely<Database>): Promise<string> {
    return (await sql<{ id: string }>`select app.record_hr_manager_event(${input.personId}::uuid,
      ${input.managerPersonId}::uuid,${input.effectiveOn}::date,${input.actorId}::uuid) as id`
      .execute(executor)).rows[0]!.id;
  }

  async endEngagement(input: { personId: string; engagementId: string; endingId: string; endedOn: string;
    sealed: SealedHrData; actorId: string }, executor: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.end_hr_engagement(${input.personId}::uuid,${input.engagementId}::uuid,${input.endingId}::uuid,
      ${input.endedOn}::date,${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},
      ${s.authTag},${input.actorId}::uuid)`.execute(executor);
  }

  async createCorrection(input: { id: string; personId: string; category: HrCorrectionCategory;
    sealed: SealedHrData; actorId: string }, executor: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.create_hr_correction_request(${input.id}::uuid,${input.personId}::uuid,
      ${input.category},${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},
      ${input.actorId}::uuid)`.execute(executor);
  }

  async decideCorrection(input: { personId: string; eventId: string; requestId: string; outcome: 'resolved' | 'rejected';
    sealed: SealedHrData; actorId: string }, executor: Kysely<Database>): Promise<void> {
    const s = input.sealed;
    await sql`select app.decide_hr_correction_request(${input.personId}::uuid,${input.eventId}::uuid,${input.requestId}::uuid,
      ${input.outcome},${s.context},${s.keyVersion}::smallint,${s.nonce},${s.ciphertext},${s.authTag},
      ${input.actorId}::uuid)`.execute(executor);
  }

  async recordFile(input: { id: string; personId: string; category: HrFileCategory; workerVisible: boolean;
    metadata: SealedHrData; mediaType: string; sizeBytes: number; sha256: Buffer; storageKey: string;
    fileKey: { keyVersion: number; nonce: Buffer; ciphertext: Buffer; authTag: Buffer }; actorId: string },
    executor: Kysely<Database>): Promise<void> {
    const m = input.metadata, k = input.fileKey;
    await sql`select app.record_hr_file(${input.id}::uuid,${input.personId}::uuid,${input.category},
      ${input.workerVisible},${m.context},${m.keyVersion}::smallint,${m.nonce},${m.ciphertext},${m.authTag},
      ${input.mediaType},${input.sizeBytes}::integer,${input.sha256},${input.storageKey},${k.keyVersion}::smallint,
      ${k.nonce},${k.ciphertext},${k.authTag},${input.actorId}::uuid)`.execute(executor);
  }
}
