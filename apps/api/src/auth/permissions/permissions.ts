import type { StaffRole } from '../../database/schema.js';

/**
 * Every permission in the system. Each module adds its own when it is built.
 * Changes here are reviewed like any other code: see ADR-009.
 */
export const PERMISSIONS = ['staff.view', 'staff.invite', 'staff.roles.manage', 'staff.disable', 'audit.view'] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['administrator', 'partner', 'fee_earner', 'accounts', 'compliance'] as const satisfies readonly StaffRole[];

/** What each role allows. Matches the table in docs/authorization.md. */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  administrator: ['staff.view', 'staff.invite', 'staff.roles.manage', 'staff.disable'],
  partner: ['staff.view'],
  fee_earner: [],
  accounts: [],
  compliance: ['staff.view', 'audit.view'],
};

export function permissionsFor(roles: Iterable<StaffRole>): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}
