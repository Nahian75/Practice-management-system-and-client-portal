import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditActor } from '../audit/audit-event.js';
import type { RequestContext } from '../common/http/request-context.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import type { CddSubjectDetails } from './compliance.js';
import { findCandidates, searchTerms, type Candidate, type ScreenedSubject } from './sanctions-matching.js';
import type { AmlLicenceAction } from '../database/schema.js';
import { SanctionsRepository, type SanctionsState } from './sanctions.repository.js';

type Actor = { actor: AuditActor; accountId: string; context?: RequestContext };
const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);

export interface Screener { actor: AuditActor; accountId: string | null; context?: RequestContext }
export type ScreeningOutcome = { outcome: 'screened'; state: SanctionsState } | { outcome: 'not_found' } | { outcome: 'no_list' };

@Injectable()
export class SanctionsScreeningService {
  private readonly logger = new Logger(SanctionsScreeningService.name);

  constructor(private readonly records: SanctionsRepository, private readonly cipher: ComplianceDataCipher,
    private readonly audit: AuditService) {}

  /**
   * Screens the client record and each subject of its latest submitted CDD case against
   * the active list. CDD names are decrypted here only to search; they are never stored
   * with the result, and the audit record holds no names or match status.
   */
  async screenClient(clientId: string, by: Screener): Promise<ScreeningOutcome> {
    const status = await this.records.status();
    if (!status.listId) return { outcome: 'no_list' };
    const listId = status.listId;
    const subjects = await this.records.subjectsToScreen(clientId);
    if (!subjects) return { outcome: 'not_found' };
    const screenings: { subjectRef: string; candidates: Candidate[] }[] = [];
    for (const subject of subjects) {
      const screened: ScreenedSubject = 'sealed' in subject
        ? (({ name, dateOfBirth }) => ({ name, birth: dateOfBirth ?? null }))(this.cipher.open<CddSubjectDetails>(subject.sealed))
        : { name: subject.name, birth: subject.birth };
      const names = await this.records.namesSharingTokens(listId, searchTerms(screened).tokens);
      screenings.push({ subjectRef: subject.ref, candidates: findCandidates(screened, names) });
    }
    const state = await this.records.transaction(async (trx) => {
      for (const screening of screenings) {
        await this.records.recordScreening({ clientId, listId, ...screening, actorId: by.accountId }, trx);
      }
      await this.audit.record({ actor: by.actor, action: 'aml.screening_recorded', outcome: 'success',
        resource: { type: 'client', id: clientId }, metadata: { subjects: screenings.length }, ...by.context }, trx);
      return this.records.sanctionsState(clientId, trx);
    });
    return { outcome: 'screened', state };
  }

  /** Screens every client with an open matter against the active list, in batches. */
  async rescreenAll(): Promise<number> {
    let after: string | null = null;
    let count = 0;
    for (;;) {
      const clients = await this.records.clientsToRescreen(after);
      if (clients.length === 0) return count;
      for (const clientId of clients) {
        try {
          await this.screenClient(clientId, { actor: { type: 'system' }, accountId: null });
          count += 1;
        } catch {
          this.logger.error(`Sanctions rescreen failed for client ${clientId}`);
        }
      }
      after = clients.at(-1)!;
    }
  }

  openCandidates(before?: string) { return this.records.openCandidates(before); }

  async resolveCandidate(candidateId: string, input: { outcome: 'false_positive' | 'confirmed'; reasoning: string },
    by: { actor: AuditActor; accountId: string; context?: RequestContext }): Promise<{ outcome: 'resolved'; state: SanctionsState } | { outcome: 'not_found' } | { outcome: 'conflict' }> {
    try {
      const state = await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.resolveCandidate({ id, candidateId, outcome: input.outcome,
          sealed: this.cipher.seal({ text: input.reasoning }, `aml-resolution:${id}`), actorId: by.accountId }, trx);
        const clientId = await this.records.candidateClient(candidateId, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.screening_resolved', outcome: 'success',
          resource: { type: 'aml_screening_candidate', id: candidateId }, metadata: {}, ...by.context }, trx);
        return this.records.sanctionsState(clientId, trx);
      });
      return { outcome: 'resolved', state };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'P0002') return { outcome: 'not_found' };
      if (code === '23505') return { outcome: 'conflict' };
      throw error;
    }
  }

  sanctionsState(clientId: string) { return this.records.sanctionsState(clientId); }

  /** Only for a confirmed designation. Money is always licensed up to a stated limit. */
  async recordLicence(input: {
    clientId: string; authority: 'ofsi' | 'otsi' | 'other'; kind: 'specific' | 'general'; reference: string;
    permittedActions: AmlLicenceAction[]; moneyLimitPence: string | null; effectiveFrom: string; expiresOn: string; conditions: string;
  }, by: Actor): Promise<{ outcome: 'recorded'; licenceId: string } | { outcome: 'not_found' } | { outcome: 'conflict' }> {
    try {
      const licenceId = await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.recordLicence({ ...input, id, conditions: this.cipher.seal({ text: input.conditions }, `aml-licence:${id}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.licence_recorded', outcome: 'success',
          resource: { type: 'aml_sanctions_licence', id }, metadata: { clientId: input.clientId }, ...by.context }, trx);
        return id;
      });
      return { outcome: 'recorded', licenceId };
    } catch (error) {
      if (errorCode(error) === 'P0002') return { outcome: 'not_found' };
      if (errorCode(error) === '23514') return { outcome: 'conflict' };
      throw error;
    }
  }

  async revokeLicence(licenceId: string, reason: string, by: Actor): Promise<{ outcome: 'revoked' } | { outcome: 'not_found' } | { outcome: 'conflict' }> {
    try {
      await this.records.transaction(async (trx) => {
        const id = await this.records.newId(trx);
        await this.records.revokeLicence({ id, licenceId, sealed: this.cipher.seal({ text: reason }, `aml-licence-revocation:${id}`),
          actorId: by.accountId }, trx);
        await this.audit.record({ actor: by.actor, action: 'aml.licence_revoked', outcome: 'success',
          resource: { type: 'aml_sanctions_licence', id: licenceId }, metadata: {}, ...by.context }, trx);
      });
      return { outcome: 'revoked' };
    } catch (error) {
      if (errorCode(error) === 'P0002') return { outcome: 'not_found' };
      if (errorCode(error) === '23505') return { outcome: 'conflict' };
      throw error;
    }
  }

  async licences(clientId: string) {
    return (await this.records.licences(clientId)).map(({ conditions, ...licence }) => ({
      ...licence, conditions: this.cipher.open<{ text: string }>(conditions).text }));
  }

  frozenFunds(clientId: string) { return this.records.frozenFunds(clientId); }
  moneyStatus(matterId: string) { return this.records.moneyStatus(matterId); }
}
