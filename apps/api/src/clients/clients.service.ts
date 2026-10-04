import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Client, NewClient } from './client.js';
import { ClientsRepository } from './clients.repository.js';

/** The signed-in staff member acting, and the request it came from. */
export interface ClientActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

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
}
