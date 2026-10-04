import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { SecurityNoticesService } from '../auth/notices/security-notices.service.js';
import { permissionsFor } from '../auth/permissions/permissions.js';
import { RolesRepository } from '../auth/permissions/roles.repository.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { ClientKind } from '../database/schema.js';
import type {
  Address,
  Client,
  ClientPatch,
  ClientSummary,
  Contact,
  ContactDetails,
  ContactPatch,
  NewClient,
} from './client.js';
import { ClientsRepository } from './clients.repository.js';
import { SearchQuota } from './search-quota.js';

export const CLIENTS_PAGE_SIZE = 50;
export const SEARCH_RESULTS_LIMIT = 20;

export type SearchResult = { outcome: 'found'; clients: ClientSummary[] } | { outcome: 'limited' };

/** The signed-in staff member acting, and the request it came from. */
export interface ClientActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type UpdateResult =
  | { outcome: 'updated'; client: Client }
  | { outcome: 'not_found' }
  | { outcome: 'kind_mismatch'; kind: ClientKind };

@Injectable()
export class ClientsService {
  constructor(
    private readonly clients: ClientsRepository,
    private readonly audit: AuditService,
    private readonly roles: RolesRepository,
    private readonly notices: SecurityNoticesService,
    private readonly quota: SearchQuota,
  ) {}

  /** The audit record names the kind only: client details are personal data and stay out of the log. */
  create(client: NewClient, by: ClientActor): Promise<{ id: string; reference: string }> {
    return this.clients.transaction(async (trx) => {
      const created = await this.clients.insert(client, by.accountId, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.created',
          outcome: 'success',
          resource: { type: 'client', id: created.id },
          metadata: { kind: client.kind },
          ...by.context,
        },
        trx,
      );
      return created;
    });
  }

  find(clientId: string, viewerId: string): Promise<Client | undefined> {
    return this.clients.findVisible(clientId, viewerId);
  }

  /** One page of the clients `viewerId` may see; `next` is passed back as `before` for the next page. */
  async list(viewerId: string, before?: string): Promise<{ clients: ClientSummary[]; next: string | null }> {
    const clients = await this.clients.listVisible(viewerId, { before, limit: CLIENTS_PAGE_SIZE });
    return { clients, next: clients.length === CLIENTS_PAGE_SIZE ? (clients.at(-1)?.reference ?? null) : null };
  }

  /**
   * Searches every client, within the hourly allowance shared with conflict
   * checks (review C2). Each search is recorded with its number of results,
   * not the text searched for, and that record is what the allowance counts.
   */
  search(text: string, by: ClientActor): Promise<SearchResult> {
    return this.clients.transaction(async (trx): Promise<SearchResult> => {
      if (!(await this.quota.allows(by, trx))) {
        return { outcome: 'limited' };
      }

      const clients = await this.clients.search(text, SEARCH_RESULTS_LIMIT, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.searched',
          outcome: 'success',
          metadata: { results: clients.length },
          ...by.context,
        },
        trx,
      );
      return { outcome: 'found', clients };
    });
  }

  /**
   * Changes the fields in `patch`. The audit record lists which fields changed,
   * never their old or new values. Nothing is recorded when nothing changed.
   */
  update(clientId: string, patch: ClientPatch, by: ClientActor): Promise<UpdateResult> {
    return this.clients.transaction(async (trx): Promise<UpdateResult> => {
      // Locked before reading, so two edits at once cannot both report the same change.
      const current = (await this.clients.lockVisible(clientId, by.accountId, trx))
        ? await this.clients.findVisible(clientId, by.accountId, trx)
        : undefined;
      if (!current) {
        return { outcome: 'not_found' };
      }
      if (current.kind !== patch.kind) {
        return { outcome: 'kind_mismatch', kind: current.kind };
      }

      const fields = changedFields(current, patch);
      if (fields.length === 0) {
        return { outcome: 'updated', client: current };
      }
      await this.clients.updateDetails(clientId, patch, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.updated',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { fields: fields.join(',') },
          ...by.context,
        },
        trx,
      );
      const updated = await this.clients.findVisible(clientId, by.accountId, trx);
      if (!updated) {
        throw new Error('Client disappeared during its update');
      }
      return { outcome: 'updated', client: updated };
    });
  }

  /** Adds a contact to an organisation client the caller can see. */
  addContact(clientId: string, contact: ContactDetails, by: ClientActor): Promise<AddContactResult> {
    return this.clients.transaction(async (trx): Promise<AddContactResult> => {
      const client = (await this.clients.lockVisible(clientId, by.accountId, trx))
        ? await this.clients.findVisible(clientId, by.accountId, trx)
        : undefined;
      if (!client) {
        return { outcome: 'not_found' };
      }
      if (client.kind !== 'organisation') {
        return { outcome: 'not_organisation' };
      }

      const contactId = await this.clients.insertContact(clientId, contact, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.contact_added',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { contactId },
          ...by.context,
        },
        trx,
      );
      return { outcome: 'added', contactId };
    });
  }

  /**
   * Changes a contact's details, or marks them inactive or active again. Like
   * client changes, the audit record lists field names only.
   */
  updateContact(clientId: string, contactId: string, patch: ContactPatch, by: ClientActor): Promise<UpdateContactResult> {
    return this.clients.transaction(async (trx): Promise<UpdateContactResult> => {
      const current = (await this.clients.lockVisible(clientId, by.accountId, trx))
        ? await this.clients.findVisibleContact(clientId, contactId, by.accountId, trx)
        : undefined;
      if (!current) {
        return { outcome: 'not_found' };
      }

      const before = new Map<string, unknown>(Object.entries(current));
      const fields = Object.entries(patch)
        .filter(([field, value]) => value !== undefined && before.get(field) !== value)
        .map(([field]) => field)
        .sort();
      if (fields.length === 0) {
        return { outcome: 'updated', contact: current };
      }
      await this.clients.updateContact(contactId, patch, trx);
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.contact_updated',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { contactId, fields: fields.join(',') },
          ...by.context,
        },
        trx,
      );
      const updated = await this.clients.findVisibleContact(clientId, contactId, by.accountId, trx);
      if (!updated) {
        throw new Error('Contact disappeared during its update');
      }
      return { outcome: 'updated', contact: updated };
    });
  }

  /**
   * Makes the caller responsible for a client whose responsible person can no
   * longer see it: their account is disabled, or they no longer hold
   * `clients.view`. Works for clients the caller cannot see yet: they find it
   * through search. The reason is stored with the change, not in the audit
   * log, which points to it instead.
   */
  async takeOver(clientId: string, reason: string, by: ClientActor): Promise<TakeOverResult> {
    const outcome = await this.clients.transaction(async (trx): Promise<TakeOverOutcome> => {
      await this.clients.lockResponsibility(clientId, trx);
      const current = await this.clients.findResponsible(clientId, trx);
      if (!current) {
        return { result: 'not_found' };
      }
      const responsibleRoles = await this.roles.activeRoles(current.responsible_id, trx);
      if (current.status !== 'disabled' && permissionsFor(responsibleRoles).has('clients.view')) {
        return { result: 'responsible_has_access' };
      }

      const changeId = await this.clients.recordResponsibilityChange(
        { clientId, fromAccountId: current.responsible_id, toAccountId: by.accountId, reason },
        trx,
      );
      await this.audit.record(
        {
          actor: by.actor,
          action: 'client.taken_over',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { changeId, from: current.responsible_id },
          ...by.context,
        },
        trx,
      );
      return {
        result: 'taken_over',
        notice: { clientReference: current.reference, fromAccountId: current.responsible_id, toAccountId: by.accountId },
      };
    });

    // Sent once the change has committed, so nobody is told about a takeover that was rolled back.
    if (outcome.notice) {
      await this.notices.clientTakenOver(outcome.notice);
    }

    // Trying to take a client from someone who still has it is worth noticing.
    if (outcome.result === 'responsible_has_access') {
      await this.audit.record({
        actor: by.actor,
        action: 'client.take_over_refused',
        outcome: 'denied',
        resource: { type: 'client', id: clientId },
        metadata: { reason: 'responsible_has_access' },
        ...by.context,
      });
    }
    return outcome.result;
  }
}

export type TakeOverResult = 'taken_over' | 'not_found' | 'responsible_has_access';

interface TakeOverOutcome {
  result: TakeOverResult;
  notice?: { clientReference: string; fromAccountId: string; toAccountId: string };
}

export type AddContactResult = { outcome: 'added'; contactId: string } | { outcome: 'not_found' | 'not_organisation' };

export type UpdateContactResult = { outcome: 'updated'; contact: Contact } | { outcome: 'not_found' };

/** Names of the fields in `patch` whose value differs from `current`, in a stable order. */
function changedFields(current: Client, patch: ClientPatch): string[] {
  const before = new Map<string, unknown>(Object.entries(current));
  const fields = Object.entries(patch)
    .filter(([field, value]) => field !== 'kind' && field !== 'address' && value !== undefined && before.get(field) !== value)
    .map(([field]) => field);
  if (patch.address !== undefined && !sameAddress(current.address, patch.address)) {
    fields.push('address');
  }
  return fields.sort();
}

function sameAddress(a: Address | null, b: Address | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.line1 === b.line1 && a.line2 === b.line2 && a.town === b.town && a.postcode === b.postcode && a.country === b.country;
}
