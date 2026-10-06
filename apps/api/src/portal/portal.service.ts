import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import { InvitationsService } from '../auth/invitations/invitations.service.js';
import { SecurityNoticesService } from '../auth/notices/security-notices.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import { PortalRepository, type PersonOnRecord, type PortalPerson } from './portal.repository.js';

/** The signed-in staff member acting, and the request it came from. */
export interface PortalActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type GrantResult =
  | { outcome: 'granted'; linkId: string; accountId: string; invited: boolean }
  | {
      outcome:
        | 'not_found'
        | 'no_such_person'
        | 'no_email'
        | 'already_linked'
        | 'email_used_by_staff'
        | 'account_disabled';
    };

/**
 * Giving a client's person access to the portal, and ending it. Access goes
 * only to the email address on the client's record: a new login is invited
 * there; someone who already uses the portal is linked and told.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly portal: PortalRepository,
    private readonly invitations: InvitationsService,
    private readonly notices: SecurityNoticesService,
    private readonly audit: AuditService,
  ) {}

  /** `contactId` names the contact, for an organisation client; none for an individual client themself. */
  async grant(clientId: string, contactId: string | undefined, by: PortalActor): Promise<GrantResult> {
    const kind = await this.portal.visibleClientKind(clientId, by.accountId);
    if (!kind) {
      return { outcome: 'not_found' };
    }
    const person = await this.personFor(kind, clientId, contactId);
    if (!person) {
      return { outcome: 'no_such_person' };
    }
    if (!person.email) {
      return { outcome: 'no_email' };
    }

    const existing = await this.portal.accountByEmail(person.email);
    if (existing?.kind === 'staff') {
      return { outcome: 'email_used_by_staff' };
    }
    if (existing?.status === 'disabled') {
      return { outcome: 'account_disabled' };
    }
    if (existing && (await this.portal.hasActiveLink(existing.id, clientId))) {
      return { outcome: 'already_linked' };
    }

    // An account in use is linked and told; a new login, or one not yet set up, is (re)invited.
    const inUse = existing?.status === 'active' ? existing : undefined;
    const invite = inUse === undefined;
    const accountId =
      inUse?.id ?? (await this.invitations.invite({ kind: 'client', email: person.email, displayName: person.displayName }, by)).accountId;

    try {
      const link = await this.portal.transaction(async (trx) => {
        const created = await this.portal.link({ accountId, clientId, contactId: person.contactId, linkedBy: by.accountId }, trx);
        await this.audit.record(
          {
            actor: by.actor,
            action: 'portal.access_granted',
            outcome: 'success',
            resource: { type: 'client', id: clientId },
            metadata: { linkId: created.id, accountId, invited: invite, ...(person.contactId ? { contactId: person.contactId } : {}) },
            ...by.context,
          },
          trx,
        );
        return created;
      });
      if (!invite) {
        await this.notices.portalAccessAdded(accountId);
      }
      return { outcome: 'granted', linkId: link.id, accountId, invited: invite };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        return { outcome: 'already_linked' };
      }
      throw error;
    }
  }

  /** The people who can see the client in the portal now; undefined if `viewerId` cannot see the client. */
  async people(clientId: string, viewerId: string): Promise<PortalPerson[] | undefined> {
    if (!(await this.portal.visibleClientKind(clientId, viewerId))) {
      return undefined;
    }
    return this.portal.activeLinks(clientId);
  }

  /** Ends a person's access to the client at once. */
  async end(clientId: string, linkId: string, by: PortalActor): Promise<'ended' | 'not_found'> {
    if (!(await this.portal.visibleClientKind(clientId, by.accountId))) {
      return 'not_found';
    }
    return this.portal.transaction(async (trx) => {
      const ended = await this.portal.end(linkId, clientId, by.accountId, trx);
      if (!ended) {
        return 'not_found';
      }
      await this.audit.record(
        {
          actor: by.actor,
          action: 'portal.access_ended',
          outcome: 'success',
          resource: { type: 'client', id: clientId },
          metadata: { linkId, accountId: ended.accountId },
          ...by.context,
        },
        trx,
      );
      return 'ended';
    });
  }

  private personFor(kind: 'individual' | 'organisation', clientId: string, contactId: string | undefined): Promise<PersonOnRecord | undefined> {
    if (kind === 'individual') {
      return contactId ? Promise.resolve(undefined) : this.portal.individual(clientId);
    }
    return contactId ? this.portal.activeContact(clientId, contactId) : Promise.resolve(undefined);
  }
}
