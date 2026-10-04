import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { ClientKind } from '../database/schema.js';
import type { Address, Client, ClientPatch, ClientSummary, NewClient } from './client.js';
import { ClientsRepository } from './clients.repository.js';

export const CLIENTS_PAGE_SIZE = 50;
export const SEARCH_RESULTS_LIMIT = 20;

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

  search(text: string): Promise<ClientSummary[]> {
    return this.clients.search(text, SEARCH_RESULTS_LIMIT);
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
}

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
