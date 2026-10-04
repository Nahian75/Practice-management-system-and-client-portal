import { Injectable } from '@nestjs/common';
import { permissionsFor, type Permission } from './permissions.js';
import { RolesRepository } from './roles.repository.js';

@Injectable()
export class PermissionsService {
  constructor(private readonly roles: RolesRepository) {}

  /**
   * Read from the database on every call, never cached in the session, so a
   * revoked role stops working on the next request.
   */
  async has(accountId: string, permission: Permission): Promise<boolean> {
    return permissionsFor(await this.roles.activeRoles(accountId)).has(permission);
  }
}
