import type { StaffRole } from '../../database/schema.js';

/**
 * Every permission in the system. Each module adds its own when it is built.
 * Changes here are reviewed like any other code: see ADR-009.
 */
export const PERMISSIONS = [
  'staff.view',
  'staff.invite',
  'staff.roles.manage',
  'staff.disable',
  'audit.view',
  'clients.create',
  'clients.view',
  'clients.search',
  'clients.edit',
  'clients.take_over',
  'matters.open',
  'matters.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['administrator', 'partner', 'fee_earner', 'accounts', 'compliance'] as const satisfies readonly StaffRole[];

/**
 * Roles whose last active holder cannot be removed: without an administrator
 * nobody can manage staff, and without compliance nobody can read the audit log.
 */
export const PROTECTED_ROLES = ['administrator', 'compliance'] as const satisfies readonly StaffRole[];

export type ProtectedRole = (typeof PROTECTED_ROLES)[number];

/**
 * Roles whose grant is emailed to every compliance holder: they reach staff
 * management, the audit log and client money, so a grant made through a
 * misused administrator account must not go unnoticed.
 */
export const SENSITIVE_ROLES: readonly StaffRole[] = ['administrator', 'compliance', 'accounts'];

/** What each role allows. Matches the table in docs/authorization.md. */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  administrator: ['staff.view', 'staff.invite', 'staff.roles.manage', 'staff.disable'],
  partner: [
    'staff.view',
    'clients.create',
    'clients.view',
    'clients.search',
    'clients.edit',
    'clients.take_over',
    'matters.open',
    'matters.view',
  ],
  fee_earner: ['clients.create', 'clients.view', 'clients.search', 'clients.edit', 'matters.open', 'matters.view'],
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
